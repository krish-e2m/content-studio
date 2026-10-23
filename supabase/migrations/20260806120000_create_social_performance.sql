-- =============================================================================
-- Social performance — scraped public metrics, moved off a local JSON file
-- (server/.cache/social.json) into Postgres + Supabase Storage.
--
-- WHERE A CHANNEL LIVES
--
--   clients.social_media_accounts (jsonb)   Channel identity AND its scraped
--     state, on the same entry. The handle you type in Profile → Channels is
--     config; the scrape writes its results back under a nested `stats` key:
--
--       { "platform": "instagram", "handle": "...", "url": "...",
--         "stats": { "name", "profileUrl", "avatarUrl", "avatarPath",
--                    "avatarSourceUrl", "followers", "following", "postsCount",
--                    "verified", "engagementRate", "postsFound", "postsNew",
--                    "lastRunAt", "lastError", "lastErroredAt" } }
--
--     `stats` is nested rather than flat so a scraped field can never collide
--     with a config field the setup form owns. There is deliberately no
--     separate channels table: one row per channel in two places is one row
--     too many, and it drifted the moment both existed.
--
--   social_posts / social_snapshots (below) are many-rows-per-channel, which
--     is the wrong shape for a jsonb blob — they need indexes, appends and a
--     unique key, so they stay relational.
--
-- Numbers are NULLABLE throughout. null means "the platform doesn't publish
-- this" (X view counts, LinkedIn reach) and must never read as a zero.
-- =============================================================================

create extension if not exists pgcrypto;  -- gen_random_uuid()


-- ---------------------------------------------------------------------------
-- Posts — upserted per scrape, never deleted.
--
-- A scrape only returns the 10 most recent posts, and the old file cache
-- replaced its list wholesale each refresh, so anything older was lost the
-- moment an account posted again. Here posts upsert on
-- (client_id, platform, external_id): counts on known posts update in place,
-- genuinely new posts are inserted, and nothing is dropped. Over time that
-- turns a 10-post sample into a real one — which is what the timing heatmap
-- needs to stop hedging its "best time to post".
-- ---------------------------------------------------------------------------
create table if not exists public.social_posts (
  id                uuid primary key default gen_random_uuid(),

  client_id         uuid not null references public.clients (id) on delete cascade,
  platform          text not null,
  external_id       text not null,          -- the platform's own post id

  url               text,
  caption           text not null default '',
  title             text not null default '',
  published_at      timestamptz,

  likes             integer,
  comments          integer,
  shares            integer,
  views             integer,

  is_video          boolean not null default false,

  -- Poster frame, mirrored into Storage. Platform CDN links are signed and
  -- expire (and 403 on hotlink), so the bytes are copied at scrape time and
  -- everything downstream points at our own copy.
  thumb_url         text,
  thumb_path        text,
  thumb_source_url  text,

  -- Video files are deliberately NOT mirrored — a poster frame is ~150KB, a
  -- post video is 5-50MB. This is the platform's own URL, so it expires: a
  -- link out, not a durable asset.
  video_url         text,

  -- first_seen_at is set once on insert and never touched by an upsert, so the
  -- pair tells you how long a post has been tracked.
  first_seen_at     timestamptz not null default now(),
  last_scraped_at   timestamptz not null default now(),

  unique (client_id, platform, external_id)
);

-- Serves the main read: a client's posts, newest first.
create index if not exists social_posts_client_published_idx
  on public.social_posts (client_id, published_at desc nulls last);
create index if not exists social_posts_client_platform_idx
  on public.social_posts (client_id, platform);


-- ---------------------------------------------------------------------------
-- Snapshots — append-only series, one row per channel per refresh. This is
-- what the sparklines read; a scrape sees only "now", so a trend exists only
-- once a channel has been refreshed more than once.
--
-- bigint identity rather than uuid: nothing references these rows, and a
-- monotonic key indexes tighter for an append-only log.
-- ---------------------------------------------------------------------------
create table if not exists public.social_snapshots (
  id               bigint generated always as identity primary key,

  client_id        uuid not null references public.clients (id) on delete cascade,
  platform         text not null,
  captured_at      timestamptz not null default now(),

  followers        integer,
  posts_count      integer,          -- posts returned by THAT run, not the archive
  -- numeric(8,2): a small account with one viral post legitimately produces
  -- four-figure percentages.
  engagement_rate  numeric(8,2),

  likes_total      bigint,
  comments_total   bigint,
  shares_total     bigint,
  views_total      bigint
);

create index if not exists social_snapshots_series_idx
  on public.social_snapshots (client_id, platform, captured_at);


-- ---------------------------------------------------------------------------
-- RLS: server-only, same posture as photos/ideas. The Express API uses the
-- service-role key (which bypasses RLS); enabling RLS with no policies denies
-- every direct anon/browser read.
-- ---------------------------------------------------------------------------
alter table public.social_posts     enable row level security;
alter table public.social_snapshots enable row level security;


-- ---------------------------------------------------------------------------
-- Storage bucket for mirrored post thumbnails + channel avatars.
--   {client_id}/{platform}/avatar.{ext}
--   {client_id}/{platform}/{external_id}/thumb.{ext}
-- Paths are deterministic (not content-hashed) so a re-scrape overwrites in
-- place instead of orphaning the previous file. The server also creates this
-- bucket at runtime (ensureBucket), so this is belt-and-braces.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('social-media', 'social-media', true)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------------
-- Retired tables. Both held one-row-per-channel that
-- clients.social_media_accounts now owns:
--   account_syncs    scrape bookkeeping, written by an older iteration
--   social_channels  a duplicate of it, briefly added alongside this migration
-- Dropped rather than migrated: the next refresh regenerates everything they
-- held. Harmless on a fresh project where neither exists.
-- ---------------------------------------------------------------------------
drop table if exists public.social_channels;
drop table if exists public.account_syncs;