-- Creates users and sessions.
--
-- Sessions are rows, not signed tokens. That choice is what makes sign-out real:
-- deleting a row revokes access immediately, where a signed token stays valid
-- until it expires no matter what the server thinks.

create table users (
  id             bigint generated always as identity primary key,
  email          text not null,
  password_hash  text not null,
  created_at     timestamptz not null default now(),

  -- Stored lowercased by the application, so this constraint is what actually
  -- prevents User@example.com and user@example.com becoming two accounts.
  constraint users_email_unique unique (email),
  constraint users_email_lowercase check (email = lower(email)),
  constraint users_email_shape check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint users_email_length check (char_length(email) between 3 and 254)
);

create table sessions (
  -- The session id itself, base64url of 32 random bytes. Opaque: it carries no
  -- claims and needs no signature verification, so there is no signature to get
  -- wrong.
  id          text primary key,

  user_id     bigint not null references users (id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),

  constraint sessions_id_length check (char_length(id) between 32 and 128),
  constraint sessions_expiry_after_creation check (expires_at > created_at)
);

-- Deleting a user must delete their sessions, which the foreign key handles.
-- This index is what makes that cascade, and "sign out everywhere", fast enough
-- to be worth having.
create index sessions_user_id_idx on sessions (user_id);
