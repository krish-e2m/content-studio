-- =============================================================================
-- CONTENT STUDIO & SOCIAL METRICS - CONSOLIDATED DATABASE SCHEMA
-- Run this entire script in Supabase Dashboard -> SQL Editor -> Run
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. CLIENTS TABLE
-- ---------------------------------------------------------------------------
create table if not exists public.clients (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  name                  text not null,
  slug                  text not null unique,
  contact_name          text,
  tagline               text,
  industry              text,
  website_url           text,
  status                text default 'onboarding',
  social_media_accounts jsonb not null default '[]'::jsonb,
  ref_documents         jsonb not null default '{}'::jsonb,
  documents             jsonb not null default '[]'::jsonb
);

alter table public.clients enable row level security;

-- ---------------------------------------------------------------------------
-- 2. SHARED UPDATED_AT TRIGGER FUNCTION
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. IDEAS TABLE
-- ---------------------------------------------------------------------------
create table if not exists public.ideas (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  title         text not null,
  description   text not null default '',
  audience      text not null default '',
  priority      text check (priority is null or priority in ('High', 'Medium', 'Low')),
  status        text not null default 'Idea'
                  check (status in ('Idea', 'In progress', 'Draft', 'Published')),
  tags          text[] not null default '{}',
  draft_link    text,
  platforms     text[] not null default '{linkedin}',
  content_type  jsonb not null default '{}'::jsonb,
  ref_images    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists ideas_client_id_idx  on public.ideas (client_id);
create index if not exists ideas_created_at_idx on public.ideas (created_at desc);

drop trigger if exists ideas_set_updated_at on public.ideas;
create trigger ideas_set_updated_at
  before update on public.ideas
  for each row execute function public.set_updated_at();

alter table public.ideas enable row level security;

-- ---------------------------------------------------------------------------
-- 4. PHOTOS TABLE
-- ---------------------------------------------------------------------------
create table if not exists public.photos (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  title         text not null default '',
  url           text not null,
  storage_path  text not null,
  mime          text not null default '',
  size_bytes    bigint not null default 0,
  position      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists photos_client_id_idx on public.photos (client_id);
create index if not exists photos_created_at_idx on public.photos (created_at desc);
create index if not exists photos_position_idx on public.photos (client_id, position);

drop trigger if exists photos_set_updated_at on public.photos;
create trigger photos_set_updated_at
  before update on public.photos
  for each row execute function public.set_updated_at();

alter table public.photos enable row level security;

-- ---------------------------------------------------------------------------
-- 5. RESEARCH TOPICS TABLE
-- ---------------------------------------------------------------------------
create table if not exists public.research_topics (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  title       text not null,
  source      text not null default 'manual',
  status      text not null default 'open' check (status in ('open', 'done')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists research_topics_client_id_idx on public.research_topics (client_id);
create index if not exists research_topics_created_at_idx on public.research_topics (created_at desc);
create index if not exists research_topics_status_idx on public.research_topics (client_id, status);

drop trigger if exists research_topics_set_updated_at on public.research_topics;
create trigger research_topics_set_updated_at
  before update on public.research_topics
  for each row execute function public.set_updated_at();

alter table public.research_topics enable row level security;

-- ---------------------------------------------------------------------------
-- 6. POSTS TABLE
-- ---------------------------------------------------------------------------
create table if not exists public.posts (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  idea_id       uuid references public.ideas (id) on delete set null,
  status        text not null default 'draft'
                  check (status in ('draft', 'scheduled', 'published')),
  state         jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists posts_client_id_idx on public.posts (client_id);
create index if not exists posts_idea_id_idx on public.posts (idea_id);
create index if not exists posts_status_idx on public.posts (client_id, status);
create index if not exists posts_updated_at_idx on public.posts (client_id, updated_at desc);

drop trigger if exists posts_set_updated_at on public.posts;
create trigger posts_set_updated_at
  before update on public.posts
  for each row execute function public.set_updated_at();

alter table public.posts enable row level security;

-- ---------------------------------------------------------------------------
-- 7. CLIENT LEARNINGS TABLE
-- ---------------------------------------------------------------------------
create table if not exists public.client_learnings (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  content     text not null,
  kind        text not null default 'note'
                check (kind in ('note', 'correction', 'preference', 'win')),
  source      text not null default 'manual'
                check (source in ('manual', 'edit', 'rejection')),
  created_at  timestamptz not null default now()
);

create index if not exists client_learnings_client_id_idx on public.client_learnings (client_id);
create index if not exists client_learnings_created_at_idx on public.client_learnings (created_at desc);

alter table public.client_learnings enable row level security;

-- ---------------------------------------------------------------------------
-- 8. SOCIAL PERFORMANCE TABLES
-- ---------------------------------------------------------------------------
create table if not exists public.social_posts (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references public.clients (id) on delete cascade,
  platform          text not null,
  external_id       text not null,
  url               text,
  caption           text not null default '',
  title             text not null default '',
  published_at      timestamptz,
  likes             integer,
  comments          integer,
  shares            integer,
  views             integer,
  is_video          boolean not null default false,
  thumb_url         text,
  thumb_path        text,
  thumb_source_url  text,
  video_url         text,
  comment_thread    jsonb not null default '[]'::jsonb,
  first_seen_at     timestamptz not null default now(),
  last_scraped_at   timestamptz not null default now(),
  unique (client_id, platform, external_id)
);

create index if not exists social_posts_client_published_idx
  on public.social_posts (client_id, published_at desc nulls last);
create index if not exists social_posts_client_platform_idx
  on public.social_posts (client_id, platform);

create table if not exists public.social_snapshots (
  id               bigint generated always as identity primary key,
  client_id        uuid not null references public.clients (id) on delete cascade,
  platform         text not null,
  captured_at      timestamptz not null default now(),
  followers        integer,
  posts_count      integer,
  engagement_rate  numeric(8,2),
  likes_total      bigint,
  comments_total   bigint,
  shares_total     bigint,
  views_total      bigint
);

create index if not exists social_snapshots_series_idx
  on public.social_snapshots (client_id, platform, captured_at);

alter table public.social_posts     enable row level security;
alter table public.social_snapshots enable row level security;

-- ---------------------------------------------------------------------------
-- 9. AI USAGE LEDGER TABLE & RPC FUNCTION
-- ---------------------------------------------------------------------------
create table if not exists public.ai_usage (
  id                bigint generated always as identity primary key,
  client_id         uuid references public.clients (id) on delete set null,
  client_name       text,
  user_id           uuid,
  user_email        text,
  feature           text not null default 'other',
  provider          text not null default 'openrouter',
  model             text,
  cost_usd          numeric(12,6),
  cost_source       text,
  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer,
  requests          integer not null default 1,
  generation_id     text,
  created_at        timestamptz not null default now()
);

create index if not exists ai_usage_client_created_idx
  on public.ai_usage (client_id, created_at desc);
create index if not exists ai_usage_created_idx
  on public.ai_usage (created_at desc);

alter table public.ai_usage enable row level security;

create or replace function public.ai_spend_by_client(p_since timestamptz default null)
returns table (
  client_id      uuid,
  cost_usd       numeric,
  requests       bigint,
  calls          bigint,
  unpriced_calls bigint,
  last_used_at   timestamptz
)
language sql
stable
as $$
  select
    u.client_id,
    coalesce(sum(u.cost_usd), 0)::numeric        as cost_usd,
    coalesce(sum(u.requests), 0)::bigint         as requests,
    count(*)                                     as calls,
    count(*) filter (where u.cost_usd is null)   as unpriced_calls,
    max(u.created_at)                            as last_used_at
  from public.ai_usage u
  where p_since is null or u.created_at >= p_since
  group by u.client_id
$$;

revoke all on function public.ai_spend_by_client(timestamptz) from public;
revoke all on function public.ai_spend_by_client(timestamptz) from anon, authenticated;
grant execute on function public.ai_spend_by_client(timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 10. STORAGE BUCKETS
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values 
  ('ref-documents', 'ref-documents', true),
  ('client-logos', 'client-logos', true),
  ('client-photos', 'client-photos', true),
  ('social-media', 'social-media', true)
on conflict (id) do nothing;

notify pgrst, 'reload schema';
