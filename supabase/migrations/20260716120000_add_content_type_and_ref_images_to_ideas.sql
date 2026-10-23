-- Remember the content type (per channel) and reference image(s) chosen for an
-- idea in the "Add an idea" / "Create content" modal, so the Idea Bank "Create"
-- button can generate straight away instead of re-asking for them.
--   content_type: { "<platform>": "<format>" }   e.g. {"linkedin":"Single thought"}
--   ref_images:   [ { "id", "url", "title" }, ... ]   library / uploaded photos
alter table public.ideas
  add column if not exists content_type jsonb not null default '{}'::jsonb,
  add column if not exists ref_images   jsonb not null default '[]'::jsonb;
