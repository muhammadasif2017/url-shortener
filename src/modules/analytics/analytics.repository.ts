import { pool } from '../../db/pool.ts';
import type {
  ClickTotals,
  DailyClicks,
  NewClickEvent,
  ReferrerCount,
} from './analytics.schema.ts';

/**
 * SQL for click events, and nothing else.
 *
 * Two rules govern every query here.
 *
 * The window is computed by the database, from `now()`, and never passed in as
 * an instant from the application. One clock decides what "today" means, and it
 * is the same clock the rows were written with.
 *
 * Days are UTC days, stated in the query rather than inherited from the
 * server's `TimeZone`. That setting differs between a local container and a
 * managed database, and inheriting it would split the same data into different
 * days depending on where the query ran.
 */

/**
 * Builds the start of the reporting window, as a `timestamptz`.
 *
 * Takes the placeholder number rather than assuming one. As a constant it read
 * as self-contained SQL while silently requiring every caller to bind the day
 * count as `$2`; a query that bound its parameters in another order would have
 * compared against whatever value happened to land there.
 *
 * Written so that `occurred_at` itself is never wrapped in a function. A
 * comparison against a bare column can use
 * `click_events_link_id_occurred_at_idx`; one against `occurred_at at time zone
 * 'UTC'` cannot, and would scan every row the link has.
 *
 * @param daysPlaceholder - Which `$n` carries the window length in days.
 * @returns A SQL expression for the first instant of the window.
 */
function windowStart(daysPlaceholder: number): string {
  return `
    (date_trunc('day', now() at time zone 'UTC')
       - make_interval(days => $${daysPlaceholder}::int - 1))
      at time zone 'UTC'
  `;
}

/**
 * Builds the calendar of days the breakdown covers.
 *
 * Shares the placeholder rule above: the same `$n` names the day count here and
 * in the range predicate, so the series and the filter cannot disagree.
 *
 * @param daysPlaceholder - Which `$n` carries the window length in days.
 * @returns A SQL expression producing one row per UTC day in the window.
 */
function windowCalendar(daysPlaceholder: number): string {
  return `
    select generate_series(
      date_trunc('day', now() at time zone 'UTC')
        - make_interval(days => $${daysPlaceholder}::int - 1),
      date_trunc('day', now() at time zone 'UTC'),
      interval '1 day'
    ) as day
  `;
}

/**
 * Writes one click event.
 *
 * Nothing is returned. The caller does not wait for this and has nowhere to put
 * an id, and selecting one back would cost a round trip that no reader needs.
 *
 * The row is written exactly as given. Truncation and hashing happen in the
 * service, so that a value which would violate a check constraint never reaches
 * the database: this insert is fire-and-forget, and a rejected row is a click
 * that disappears with no response to attach the failure to.
 *
 * @param event - An already-normalised event.
 */
export async function insertClick(event: NewClickEvent): Promise<void> {
  await pool().query(
    `insert into click_events (link_id, referrer, user_agent, ip_hash, is_bot)
     values ($1, $2, $3, $4, $5)`,
    [event.linkId, event.referrer, event.userAgent, event.ipHash, event.isBot],
  );
}

/** Raw counts, as `pg` returns them: `bigint` arrives as a string. */
/**
 * Deletes click events older than the retention window.
 *
 * The subquery picks the batch by primary key and the delete removes exactly
 * those rows, which keeps each statement short and its lock footprint small.
 * `occurred_at` has no index of its own, deliberately: indexing it would cost a
 * write on every click to serve a query that runs once a day, and the existing
 * index on `(link_id, occurred_at)` already covers every read path.
 *
 * @param retentionDays - How long a click is kept.
 * @param batchSize - Most rows to delete in this statement.
 * @returns How many rows were deleted.
 */
export async function deleteClicksOlderThan(
  retentionDays: number,
  batchSize: number,
): Promise<number> {
  const result = await pool().query(
    `delete from click_events
     where id in (
       select id from click_events
       where occurred_at < now() - make_interval(days => $1::int)
       limit $2
     )`,
    [retentionDays, batchSize],
  );

  return result.rowCount ?? 0;
}

type TotalsRow = {
  readonly total: string;
  readonly unique_visitors: string;
  readonly bot_clicks: string;
};

/** One day of the breakdown, before conversion. */
type DailyRow = {
  readonly date: string;
  readonly clicks: string;
};

/**
 * Counts clicks for one link over a window ending today.
 *
 * Three counts in one statement rather than three round trips, because they
 * read the same rows and `filter` costs nothing extra over a scan that already
 * has to happen.
 *
 * Bot rows are excluded from the first two and reported separately by the
 * third, so the exclusion is visible in the answer rather than silent.
 *
 * @param linkId - The link.
 * @param days - Window length, in whole UTC days, ending today.
 * @returns The counts, converted to numbers at this boundary.
 */
export async function readClickTotals(linkId: string, days: number): Promise<ClickTotals> {
  const result = await pool().query<TotalsRow>(
    `select
       count(*) filter (where not is_bot)                as total,
       count(distinct ip_hash) filter (where not is_bot) as unique_visitors,
       count(*) filter (where is_bot)                    as bot_clicks
     from click_events
     where link_id = $1
       and occurred_at >= ${windowStart(2)}`,
    [linkId, days],
  );

  // An aggregate with no `group by` returns exactly one row, even over no data,
  // where the counts are zero. A `?? 0` fallback here would read as defensive
  // and would instead hide a query that had stopped being an aggregate.
  const row = result.rows[0];
  if (row === undefined) throw new Error('Click totals query returned no row.');

  // `count(*)` is `bigint`, so every value here arrives as a string. A count in
  // this system cannot exceed Number.MAX_SAFE_INTEGER, so Number() is safe, and
  // converting here is what stops `assert.equal(total, 3)` failing against '3'.
  return {
    total: Number(row.total),
    uniqueVisitors: Number(row.unique_visitors),
    botClicks: Number(row.bot_clicks),
  };
}

/**
 * Counts clicks per UTC day across the window.
 *
 * The series is dense. `generate_series` produces every day in the window and
 * the join fills in the ones that had traffic, so a day with no clicks comes
 * back as zero rather than being absent. A sparse series makes every consumer
 * rebuild the calendar, and a missing day reads as continuity rather than as a
 * gap, which is the one thing a traffic chart must not get wrong.
 *
 * The range predicate on `occurred_at` looks redundant beside the day equality
 * below it, and is not. `date_trunc(...) = calendar.day` cannot use an index,
 * so the range is the only condition the planner can turn into an index scan.
 * Measured with `explain (analyze)` over 5,000 rows for one link: with the
 * predicate, a bitmap index scan touching 162 rows and 5 buffers; without it, a
 * sequential scan of all 5,000 and 77 buffers, sorting every row.
 *
 * @param linkId - The link.
 * @param days - Window length, in whole UTC days, ending today.
 * @returns One entry per day, oldest first, bot rows excluded.
 */
export async function readClicksByDay(linkId: string, days: number): Promise<DailyClicks[]> {
  const result = await pool().query<DailyRow>(
    `with calendar as (${windowCalendar(2)})
     select to_char(calendar.day, 'YYYY-MM-DD') as date,
            count(event.id)                     as clicks
     from calendar
     left join click_events event
       on event.link_id = $1
      and not event.is_bot
      and event.occurred_at >= ${windowStart(2)}
      and date_trunc('day', event.occurred_at at time zone 'UTC') = calendar.day
     group by calendar.day
     order by calendar.day`,
    [linkId, days],
  );

  return result.rows.map((row) => ({ date: row.date, clicks: Number(row.clicks) }));
}

/** One referrer group, before conversion. */
type ReferrerRow = {
  readonly referrer: string | null;
  readonly clicks: string;
};

/**
 * Ranks the sources of traffic for one link over a window.
 *
 * Grouping happens inside a row set the index has already narrowed to one link
 * and one window, which is why `referrer` carries no index of its own: an index
 * on high-cardinality, attacker-supplied text would cost a write on every click
 * to serve one grouped read.
 *
 * The range predicate on `occurred_at` is what makes that narrowing possible.
 * See {@link readClicksByDay} for the measurement.
 *
 * Ties break on the referrer itself, ascending, so two sources with equal
 * counts come back in the same order on every call rather than in whatever
 * order the database happened to produce. Postgres sorts nulls last under
 * `asc`, so direct traffic loses a tie, which is a stable rule rather than an
 * accident.
 *
 * @param linkId - The link.
 * @param days - Window length, in whole UTC days, ending today.
 * @param limit - Most rows to return.
 * @returns The ranked referrers, counts converted at this boundary.
 */
export async function readTopReferrers(
  linkId: string,
  days: number,
  limit: number,
): Promise<ReferrerCount[]> {
  const result = await pool().query<ReferrerRow>(
    `select referrer, count(*) as clicks
     from click_events
     where link_id = $1
       and not is_bot
       and occurred_at >= ${windowStart(2)}
     group by referrer
     order by clicks desc, referrer asc
     limit $3`,
    [linkId, days, limit],
  );

  return result.rows.map((row) => ({ referrer: row.referrer, clicks: Number(row.clicks) }));
}
