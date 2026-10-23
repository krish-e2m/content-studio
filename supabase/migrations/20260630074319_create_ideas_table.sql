-- Idea Bank: one row per content idea captured in the "Add an idea" form.
-- Columns mirror the fields on that form (and the source spreadsheet):
--   audience, title, description (note/angle), priority, status, tags, draft_link.
-- An idea belongs to a client (client_id). No user/owner column - the app has no
-- auth yet, so ideas are scoped to the client only.

create extension if not exists pgcrypto;  -- for gen_random_uuid()

create table if not exists public.ideas (
  id          uuid primary key default gen_random_uuid(),

  -- scoping
  client_id   uuid not null references public.clients (id) on delete cascade,

  -- form fields
  title       text not null,
  description text not null default '',           -- "Note / angle"
  audience    text not null default '',           -- e.g. "PE operators"
  priority    text check (priority is null or priority in ('High', 'Medium', 'Low')),
  status      text not null default 'Idea'
                check (status in ('Idea', 'In progress', 'Draft', 'Published')),
  tags        text[] not null default '{}',
  draft_link  text,
  platforms   text[] not null default '{linkedin}',

  -- bookkeeping ("Date Added")
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists ideas_client_id_idx  on public.ideas (client_id);
create index if not exists ideas_created_at_idx on public.ideas (created_at desc);

-- keep updated_at fresh on every UPDATE
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists ideas_set_updated_at on public.ideas;
create trigger ideas_set_updated_at
  before update on public.ideas
  for each row execute function public.set_updated_at();

-- Row Level Security: lock the table to server-only access. The Express API uses
-- the Supabase service-role key, which bypasses RLS; enabling RLS with no policies
-- denies any direct anon/client access. Add client-scoped policies here if/when
-- the browser ever talks to Supabase directly.
alter table public.ideas enable row level security;
