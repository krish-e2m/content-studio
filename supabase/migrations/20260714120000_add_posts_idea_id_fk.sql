-- Make posts.idea_id a real foreign key.
--
-- Until now posts.idea_id was a bare uuid column: it held the source idea's id
-- (parsed from the 'idea:<uuid>' draft_key on save) but had no referential
-- integrity, so deleting an idea left a dangling id behind. This turns it into a
-- proper foreign key to public.ideas, indexes it, and uses ON DELETE SET NULL:
-- deleting an idea keeps its finalized posts (they just become unlinked / ad-hoc)
-- rather than cascade-deleting real content. (client_id stays ON DELETE CASCADE:
-- deleting a client should remove its posts; deleting an idea should not.)

-- 0. Tidy: `state` is a jsonb column and the server writes a real object into it,
--    so rows should already hold a jsonb OBJECT. Defensively un-double-encode any
--    row that stored a JSON *string* instead (jsonb_typeof = 'string'); no-op when
--    state is already an object, so this is safe to run on healthy data.
update public.posts
set state = (state #>> '{}')::jsonb
where jsonb_typeof(state) = 'string';

-- 1. Heal existing orphans first, or the ADD CONSTRAINT below fails: null out any
--    idea_id that doesn't point at a live idea (e.g. the idea was deleted before
--    this constraint existed).
update public.posts p
set idea_id = null
where idea_id is not null
  and not exists (select 1 from public.ideas i where i.id = p.idea_id);

-- 2. Add the foreign key, guarded so the migration is safe to re-run.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'posts_idea_id_fkey'
  ) then
    alter table public.posts
      add constraint posts_idea_id_fkey
      foreign key (idea_id) references public.ideas (id) on delete set null;
  end if;
end $$;

-- 3. Index the FK column: speeds idea -> posts lookups and the ON DELETE SET NULL
--    scan when an idea is removed.
create index if not exists posts_idea_id_idx on public.posts (idea_id);
