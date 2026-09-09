import { pool } from '../../db/pool.ts';
import type { ClickTotals, DailyClicks, NewClickEvent } from './analytics.schema.ts';

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
 * Start of the reporting window, as a `timestamptz`.
 *
 * Written so that `occurred_at` itself is never wrapped in a function. A
 * comparison against a bare column can use
 * `click_events_link_id_occurred_at_idx`; one against `occurred_at at time zone
 * 'UTC'` cannot, and would scan every row the link has.
 */
const WINDOW_START = `
  (date_trunc('day', now() at time zone 'UTC') - make_interval(days => $2::int - 1))
    at time zone 'UTC'
`;

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
       and occurred_at >= ${WINDOW_START}`,
    [linkId, days],
  );

  const row = result.rows[0];

  // `count(*)` is `bigint`, so every value here arrives as a string. A count in
  // this system cannot exceed Number.MAX_SAFE_INTEGER, so Number() is safe, and
  // converting here is what stops `assert.equal(total, 3)` failing against '3'.
  return {
    total: Number(row?.total ?? 0),
    uniqueVisitors: Number(row?.unique_visitors ?? 0),
    botClicks: Number(row?.bot_clicks ?? 0),
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
 * @param linkId - The link.
 * @param days - Window length, in whole UTC days, ending today.
 * @returns One entry per day, oldest first, bot rows excluded.
 */
export async function readClicksByDay(linkId: string, days: number): Promise<DailyClicks[]> {
  const result = await pool().query<DailyRow>(
    `with calendar as (
       select generate_series(
         date_trunc('day', now() at time zone 'UTC') - make_interval(days => $2::int - 1),
         date_trunc('day', now() at time zone 'UTC'),
         interval '1 day'
       ) as day
     )
     select to_char(calendar.day, 'YYYY-MM-DD') as date,
            count(event.id)                     as clicks
     from calendar
     left join click_events event
       on event.link_id = $1
      and not event.is_bot
      and event.occurred_at >= ${WINDOW_START}
      and date_trunc('day', event.occurred_at at time zone 'UTC') = calendar.day
     group by calendar.day
     order by calendar.day`,
    [linkId, days],
  );

  return result.rows.map((row) => ({ date: row.date, clicks: Number(row.clicks) }));
}
