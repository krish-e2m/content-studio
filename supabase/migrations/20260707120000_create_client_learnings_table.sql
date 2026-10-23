-- Client learnings: the "gets better with use" tier of the brand brain. Small
-- editorial facts accumulated per client (rejected phrases, editor preferences,
-- what performed well) that the Claude content engine injects into every
-- generation via the workspace CLAUDE.md. Scoped to a client, mirrors the
-- ideas / research_topics tables.

create extension if not exists pgcrypto;  -- for gen_random_uuid()

create table if not exists public.client_learnings (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,

  -- one editorial fact, phrased as an instruction the writer can apply,
  -- e.g. "Never open with a rhetorical question - the founder hates it."
  content     text not null,
  kind        text not null default 'note'
                check (kind in ('note', 'correction', 'preference', 'win')),
  source      text not null default 'manual'
                check (source in ('manual', 'edit', 'rejection')),

  created_at  timestamptz not null default now()
);

create index if not exists client_learnings_client_id_idx  on public.client_learnings (client_id);
create index if not exists client_learnings_created_at_idx on public.client_learnings (created_at desc);

-- Row Level Security: server-only access (service-role key bypasses RLS; enabling
-- RLS with no policies denies any direct anon/client access).
alter table public.client_learnings enable row level security;
