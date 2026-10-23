-- Research topics: one row per topic captured in the Research page's "Manual"
-- tab. A topic is just a name/title, scoped to a client (client_id). No
-- user/owner column - the app has no auth yet, so topics are scoped to the
-- client only. Mirrors the ideas + photos tables.

create extension if not exists pgcrypto;  -- for gen_random_uuid()

create table if not exists public.research_topics (
  id          uuid primary key default gen_random_uuid(),

  -- scoping
  client_id   uuid not null references public.clients (id) on delete cascade,

  -- the topic
  title       text not null,

  -- bookkeeping
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists research_topics_client_id_idx  on public.research_topics (client_id);
create index if not exists research_topics_created_at_idx on public.research_topics (created_at desc);

-- keep updated_at fresh on every UPDATE (reuses the shared trigger fn from the
-- ideas migration; redefined here so this migration is self-contained)
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists research_topics_set_updated_at on public.research_topics;
create trigger research_topics_set_updated_at
  before update on public.research_topics
  for each row execute function public.set_updated_at();

-- Row Level Security: lock the table to server-only access. The Express API uses
-- the Supabase service-role key, which bypasses RLS; enabling RLS with no policies
-- denies any direct anon/client access. Add client-scoped policies here if/when
-- the browser ever talks to Supabase directly.
alter table public.research_topics enable row level security;
