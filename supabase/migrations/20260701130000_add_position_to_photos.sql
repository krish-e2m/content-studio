-- Manual ordering for the Photo Library. `position` is the drag-and-drop sort
-- key (0-based index within a client's photos). Existing rows default to 0, so
-- the list falls back to newest-first (created_at) until the user reorders.
alter table public.photos
  add column if not exists position integer not null default 0;

create index if not exists photos_position_idx on public.photos (client_id, position);
