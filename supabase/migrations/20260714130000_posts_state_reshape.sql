-- Slim `posts` to its essentials: identity (id, client_id FK, idea_id FK),
-- lifecycle (status), and the single source of truth `state` (jsonb). Drop the
-- promoted / redundant columns:
--
--   • draft_key    — the wizard now identifies a draft by its ROW ID (the client
--                    tracks the id returned on first save), so the 'idea:<id>'
--                    key and its unique(client_id, draft_key) upsert are gone.
--   • title        — derived from state.topic.
--   • scheduled_at — dates are now per-platform inside state.byPlatform.
--
-- Going forward the app writes `state` platform-first:
--   { topic, note, tags,
--     byPlatform: { <platform>: { body, hashtags, format, scheduledDate, visual } } }
-- Existing rows keep their old-shape state and are read via a backward-compatible
-- parser in the client; they re-save into the new shape the next time they're
-- opened. (No in-place jsonb rewrite here: safer on production, and the old shape
-- still loads correctly.)

-- Dropping each column also drops the objects that depend on it:
--   • unique (client_id, draft_key)  → dropped with draft_key
--   • posts_scheduled_at_idx          → dropped with scheduled_at
alter table public.posts drop column if exists draft_key;
alter table public.posts drop column if exists title;
alter table public.posts drop column if exists scheduled_at;
