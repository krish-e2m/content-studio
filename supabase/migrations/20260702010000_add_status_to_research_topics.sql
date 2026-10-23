-- Research topics gain a lifecycle: 'open' (still in the list, waiting to be
-- worked) vs 'done' (ideas have been generated + saved from it, so it drops out
-- of the active list). Soft-archive rather than delete, so the row survives and
-- can be reviewed later. Existing rows default to 'open'.

alter table public.research_topics
  add column if not exists status text not null default 'open'
    check (status in ('open', 'done'));

create index if not exists research_topics_status_idx
  on public.research_topics (client_id, status);
