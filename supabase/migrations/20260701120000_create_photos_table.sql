-- Photo Library: one row per image a user uploads for a client. The image file
-- itself lives in the "client-photos" Storage bucket (created below); this table
-- holds the metadata + the public URL and the storage path (needed to delete the
-- file). A photo belongs to a client (client_id). No user/owner column - the app
-- has no auth yet, so photos are scoped to the client only. Mirrors the ideas table.

create extension if not exists pgcrypto;  -- for gen_random_uuid()

create table if not exists public.photos (
  id            uuid primary key default gen_random_uuid(),

  -- scoping
  client_id     uuid not null references public.clients (id) on delete cascade,

  -- the image
  title         text not null default '',      -- display name (defaults to the filename)
  url           text not null,                 -- public Storage URL
  storage_path  text not null,                 -- object path inside the bucket (for deletion)
  mime          text not null default '',      -- e.g. image/png
  size_bytes    bigint not null default 0,

  -- bookkeeping
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists photos_client_id_idx  on public.photos (client_id);
create index if not exists photos_created_at_idx on public.photos (created_at desc);

-- keep updated_at fresh on every UPDATE (reuses the shared trigger fn from the
-- ideas migration; redefined here so this migration is self-contained)
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists photos_set_updated_at on public.photos;
create trigger photos_set_updated_at
  before update on public.photos
  for each row execute function public.set_updated_at();

-- Row Level Security: lock the table to server-only access. The Express API uses
-- the Supabase service-role key, which bypasses RLS; enabling RLS with no policies
-- denies any direct anon/client access. Add client-scoped policies here if/when
-- the browser ever talks to Supabase directly.
alter table public.photos enable row level security;

-- ---------------------------------------------------------------------------
-- Storage bucket (the "S3 bucket"). Supabase Storage is S3-backed; a bucket is
-- just a row in storage.buckets. Public so the returned URLs are directly
-- viewable. The server also auto-creates this bucket at runtime (ensureBucket),
-- so running this is optional - but it makes the bucket exist immediately.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('client-photos', 'client-photos', true)
on conflict (id) do nothing;
