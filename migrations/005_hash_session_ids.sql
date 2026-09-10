-- Stores a hash of the session identifier instead of the identifier itself.
--
-- The `sessions` table was a credential store. A row held the exact string the
-- browser sends back, so anyone who could read the table could impersonate every
-- signed-in user: a backup, a replica, a log that captured a query, or a future
-- query with an injection in it. Hashing removes that, the same way hashing
-- removes it for passwords. What the browser holds is still the only thing that
-- opens a session, and the table now holds a value that cannot be replayed.
--
-- SHA-256 with no salt and no work factor is deliberate here, and it is not the
-- password decision. A session id is 32 bytes from a cryptographic random
-- source, so there is no guessable input to iterate over and nothing for a work
-- factor to slow down. Salting would only prevent a lookup table across a
-- keyspace nobody can enumerate. Password hashing solves the opposite problem:
-- a low-entropy human-chosen input, where the work factor is the whole defence.
--
-- This deletes every live session, so every signed-in user is signed out when it
-- runs. There is no migration path: the existing rows hold raw identifiers, and
-- the hash of an identifier cannot be derived from a row that stores it in
-- plaintext without reading the plaintext first, which is exactly what this
-- change exists to stop relying on. Signing everyone out once is the cost.
delete from sessions;

-- The column keeps its name and its type. What changes is what the application
-- puts in it, which is why the constraint below is tightened to the exact width
-- of the hex digest: a value of any other length was not produced by the hashing
-- helper, and the database should say so rather than store it.
alter table sessions
  drop constraint sessions_id_length;

alter table sessions
  add constraint sessions_id_is_sha256_hex
  check (id ~ '^[0-9a-f]{64}$');

comment on column sessions.id is
  'SHA-256 hex digest of the session identifier. The identifier itself exists only in the client cookie and is never stored.';
