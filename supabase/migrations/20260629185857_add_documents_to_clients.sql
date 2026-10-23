-- Brand documents: a list of markdown docs attached to a client.
-- Each item is { "name": text, "content": text } where content is raw markdown.
alter table public.clients
  add column if not exists documents jsonb not null default '[]'::jsonb;
