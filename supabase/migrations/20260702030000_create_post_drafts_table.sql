-- Post drafts: in-progress Create-wizard state, so the form resumes exactly where
-- the user left off across reloads (and devices). ONE ROW PER DRAFT, keyed by
-- draft_key: 'idea:<ideaId>' when launched from an Idea Bank idea (so each idea
-- keeps its own independent draft), or 'adhoc' for a Create started without one.
-- The whole wizard state (step, platforms, drafts, visuals, checks, dates…) is
-- stored as a jsonb blob. Scoped to a client. Supersedes the old localStorage draft.

create extension if not exists pgcrypto;  -- for gen_random_uuid()

create table if not exists public.post_drafts (
  id          uuid primary key default gen_random_uuid(),

  -- scoping + identity
  client_id   uuid not null references public.clients (id) on delete cascade,
  draft_key   text not null,                          -- 'idea:<ideaId>' | 'adhoc'

  -- the wizard state blob
  state       jsonb not null default '{}'::jsonb,

  -- bookkeeping (updated_at doubles as "most recently worked" ordering)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (client_id, draft_key)                       -- one draft per key, enables upsert
);

create index if not exists post_drafts_client_id_idx  on public.post_drafts (client_id);
create index if not exists post_drafts_updated_at_idx on public.post_drafts (client_id, updated_at desc);

-- keep updated_at fresh on every UPDATE (reuses the shared trigger fn)
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists post_drafts_set_updated_at on public.post_drafts;
create trigger post_drafts_set_updated_at
  before update on public.post_drafts
  for each row execute function public.set_updated_at();

-- Row Level Security: server-only access (service-role key bypasses RLS).
alter table public.post_drafts enable row level security;
