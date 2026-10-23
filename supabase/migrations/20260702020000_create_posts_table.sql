-- Posts: the output of the Create wizard. One Create session can target several
-- platforms at once, and each platform gets its own tailored draft - so we store
-- ONE ROW PER PLATFORM. Rows produced by the same session share a batch_id, which
-- keeps a multi-platform post grouped while still letting each channel carry its
-- own format, body, hashtags, visual and schedule date. Scoped to a client
-- (client_id). Mirrors the ideas / photos / research_topics tables.

create extension if not exists pgcrypto;  -- for gen_random_uuid()

create table if not exists public.posts (
  id            uuid primary key default gen_random_uuid(),

  -- scoping + grouping
  client_id     uuid not null references public.clients (id) on delete cascade,
  batch_id      uuid,                                  -- groups a multi-platform Create session

  -- the idea behind the post (shared across a batch)
  title         text not null default '',              -- "Working on" topic
  note          text not null default '',              -- "Angle / note"

  -- per-platform content
  platform      text not null,                         -- linkedin | instagram | substack | email | x
  format        text not null default '',              -- e.g. "Single thought"
  body          text not null default '',              -- the draft copy
  hashtags      text not null default '',
  visual        jsonb not null default '{}'::jsonb,     -- { path, photoIds[], prompt, src }
  image_prompt  text not null default '',

  -- scheduling / lifecycle
  scheduled_date date,
  status        text not null default 'Scheduled'
                  check (status in ('Draft', 'Scheduled', 'Published')),

  -- bookkeeping
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists posts_client_id_idx      on public.posts (client_id);
create index if not exists posts_batch_id_idx        on public.posts (batch_id);
create index if not exists posts_scheduled_date_idx  on public.posts (scheduled_date);
create index if not exists posts_created_at_idx      on public.posts (created_at desc);

-- keep updated_at fresh on every UPDATE (reuses the shared trigger fn from the
-- ideas migration; redefined here so this migration is self-contained)
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

-- Row Level Security: server-only access (service-role key bypasses RLS; enabling
-- RLS with no policies denies any direct anon/client access).
alter table public.posts enable row level security;
