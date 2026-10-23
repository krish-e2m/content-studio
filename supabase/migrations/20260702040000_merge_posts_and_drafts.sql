-- Merge `posts` + `post_drafts` into ONE table. A draft and a finalized post are
-- the same Create-wizard session at different lifecycle stages, so keeping two
-- tables was redundant. Now there is one row per session:
--   status = 'draft'      → in progress (autosaved, resumable via draft_key)
--   status = 'scheduled'  → finalized (draft_key released to NULL)
-- The whole wizard state (topic, note, platforms, per-platform drafts, visuals,
-- dates, checks, tags…) lives in the `state` jsonb blob; a few fields are promoted
-- to columns (title, idea_id, scheduled_at) for listing/querying.

-- Drop the two separate tables (safe: these were new this session).
drop table if exists public.post_drafts;
drop table if exists public.posts;

create extension if not exists pgcrypto;  -- for gen_random_uuid()

create table if not exists public.posts (
  id            uuid primary key default gen_random_uuid(),

  -- scoping + identity
  client_id     uuid not null references public.clients (id) on delete cascade,
  idea_id       uuid,                                  -- source idea (null for ad-hoc); survives finalize
  draft_key     text,                                  -- 'idea:<id>' | 'adhoc' while a draft; NULL once finalized

  -- lifecycle
  status        text not null default 'draft'
                  check (status in ('draft', 'scheduled', 'published')),

  -- promoted for lists / calendar (source of truth is `state`)
  title         text not null default '',              -- the "Working on" topic
  scheduled_at  date,                                  -- shared publish date, set on finalize

  -- the full wizard state blob (platforms, per-platform drafts, visuals, dates…)
  state         jsonb not null default '{}'::jsonb,

  -- bookkeeping (updated_at doubles as "most recently worked" ordering)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- one live draft per key; finalized rows have draft_key NULL (NULLs are distinct)
  unique (client_id, draft_key)
);

create index if not exists posts_client_id_idx   on public.posts (client_id);
create index if not exists posts_status_idx        on public.posts (client_id, status);
create index if not exists posts_updated_at_idx    on public.posts (client_id, updated_at desc);
create index if not exists posts_scheduled_at_idx  on public.posts (client_id, scheduled_at);

-- keep updated_at fresh on every UPDATE (reuses the shared trigger fn)
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists posts_set_updated_at on public.posts;
create trigger posts_set_updated_at
  before update on public.posts
  for each row execute function public.set_updated_at();

-- Row Level Security: server-only access (service-role key bypasses RLS).
alter table public.posts enable row level security;
