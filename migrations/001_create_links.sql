-- Creates the links table.
--
-- Every rule below is enforced here as well as in application code. Validation
-- in the service is a courtesy that produces a helpful message; the constraint
-- is what makes the rule true, including for a migration, a psql session, or a
-- future code path that forgets to validate.

create table links (
  id          bigint generated always as identity primary key,
  slug        text not null,
  url         text not null,
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),

  -- The real guard against slug collisions. The retry loop in the service
  -- exists only so a rare collision is retried instead of surfacing as a 500;
  -- it is not what makes slugs unique.
  constraint links_slug_unique unique (slug),

  constraint links_slug_length check (char_length(slug) between 3 and 32),

  -- Excludes "." on purpose, so a slug can never look like robots.txt, and so
  -- the reserved-word list and this constraint cannot disagree.
  constraint links_slug_charset check (slug ~ '^[A-Za-z0-9_-]+$'),

  constraint links_url_length check (char_length(url) <= 2048),

  -- A link that expired before it existed is meaningless, and would make the
  -- redirect route return 410 for something that never worked.
  constraint links_expiry_after_creation
    check (expires_at is null or expires_at > created_at)
);

-- No index is created for the listing query. It orders by `id desc`, which the
-- primary key index already serves. An index on created_at would be dead weight
-- unless the cursor changes to order by time.
