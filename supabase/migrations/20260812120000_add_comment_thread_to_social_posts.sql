-- Comment *text* for scraped posts (TikTok first; the column is platform-agnostic).
-- Counts already live in social_posts.comments; this is the visible thread the
-- Performance detail modal renders. Nullable / default empty so older rows
-- and platforms that only expose a count stay valid.
alter table public.social_posts
  add column if not exists comment_thread jsonb not null default '[]'::jsonb;
