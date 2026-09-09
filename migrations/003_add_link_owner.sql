-- Gives links an owner.
--
-- Nullable, and permanently so. Links created before this migration have no
-- owner and there is no way to prove who made them, so there is no claim flow.
-- Anonymous creation also survives as a feature, which means new rows with a
-- null owner keep arriving.
alter table links
  add column owner_id bigint references users (id) on delete cascade;

-- Listing is scoped to one owner and ordered by id descending. A composite
-- index in that exact shape lets the query walk the index backwards and stop at
-- the page size, instead of scanning every link the service has ever stored and
-- discarding the ones belonging to other people.
create index links_owner_id_idx on links (owner_id, id desc);
