-- Creates the click events table.
--
-- One row per redirect. A counter column on links was rejected in SPEC.md
-- because it answers no question beyond a total: not when the traffic arrived,
-- and not where it came from.
--
-- Rows arrive from a write the redirect handler does not await, so nothing here
-- may be able to reject an insert that the application considers valid. The
-- length constraints below are backstops against a future write path that
-- forgets to truncate, not the enforcement point. A constraint violation on a
-- fire-and-forget insert loses the click in silence.

create table click_events (
  id           bigint generated always as identity primary key,

  -- Cascade, so deleting a link destroys its history with it. That is
  -- irreversible and is a second reason the unauthenticated delete route must
  -- stay closed in any deployed environment.
  link_id      bigint not null references links (id) on delete cascade,

  occurred_at  timestamptz not null default now(),

  -- Both headers are attacker-supplied and routinely absent. Absent is stored
  -- as null rather than as an empty string, so "no referrer" is one value
  -- instead of two, and so direct traffic groups correctly in the referrers
  -- query.
  referrer     text,
  user_agent   text,

  -- Hex sha256 over the salt followed by the resolved client IP. The raw
  -- address is never stored. This exists only to count distinct visitors, and
  -- there is deliberately no query that looks a hash up across links, which
  -- would turn counting into tracking.
  ip_hash      text not null,

  -- Obvious automation is flagged and kept, never dropped. Discarding the row
  -- would make a crawler wave and a collapse in real traffic look identical
  -- afterwards, with no way to tell them apart.
  is_bot       boolean not null default false,

  constraint click_events_referrer_length
    check (char_length(referrer) <= 2048),

  constraint click_events_user_agent_length
    check (char_length(user_agent) <= 512),

  -- sha256 hex is always exactly 64 characters, so a wrong length means the
  -- value was not produced by the hashing helper.
  constraint click_events_ip_hash_length
    check (char_length(ip_hash) = 64)
);

-- Every query in the analytics module starts by narrowing to one link and then
-- to a time window: the total, the per-day breakdown, the distinct-visitor
-- count, and the top referrers. This index is that shape, so one index serves
-- all four.
--
-- Its leading column also covers the foreign key, so cascading a link deletion
-- does not scan the table.
--
-- Nothing else is indexed on purpose. `referrer` is high-cardinality
-- attacker-supplied text that would cost a write on every click to serve one
-- grouped read; `ip_hash` is only ever counted inside a set this index has
-- already narrowed; and `is_bot` is filtered within that same narrow set.
create index click_events_link_id_occurred_at_idx
  on click_events (link_id, occurred_at desc);
