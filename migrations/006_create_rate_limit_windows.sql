-- Rate-limit counters that every instance shares.
--
-- The in-process limiter this replaces on the API paths counted per process. Two
-- instances kept two counters, so the effective limit was the configured maximum
-- multiplied by however many instances happened to be running, and the
-- ten-attempt limit on the credential routes became ten per instance. A limit
-- that quietly scales with the deployment is worse than no limit, because it
-- looks like a control in the code and is not one in production.
--
-- PostgreSQL rather than Redis because this service has one production
-- dependency and one operational component, and adding a second of each to hold
-- a few thousand integers is a poor trade. The cost is one round trip per
-- limited request, paid only on the API paths, which are low volume. The
-- redirect path keeps the in-process limiter for the reason recorded in
-- `src/server.ts`.
create table rate_limit_windows (
  -- What is being counted: a purpose prefix and the identity it applies to,
  -- such as 'api:203.0.113.4' or 'login-failure:sha256-of-email'. The prefix is
  -- part of the key so that two limits on the same client cannot collide, and
  -- so a limit can be introduced or removed without touching the others.
  --
  -- The identity is not necessarily an address. Where a key would otherwise
  -- carry personal data, the application hashes it first, so this table holds no
  -- email address and no raw client address.
  bucket      text primary key,

  -- Requests seen in the current window. Incremented by an upsert that also
  -- rolls the window over when it has passed, so a request never reads a stale
  -- count and then writes a decision based on it.
  count       integer not null,

  -- When the current window ends. Rows past this instant are dead and are
  -- treated as absent by the upsert, whether or not the sweep has removed them
  -- yet, so correctness never depends on the sweep running.
  expires_at  timestamptz not null,

  constraint rate_limit_windows_count_positive check (count > 0),
  constraint rate_limit_windows_bucket_length check (char_length(bucket) between 1 and 200)
);

-- The sweep deletes by expiry across the whole table, which is the only query
-- here that is not a primary-key lookup.
create index rate_limit_windows_expires_at_idx on rate_limit_windows (expires_at);
