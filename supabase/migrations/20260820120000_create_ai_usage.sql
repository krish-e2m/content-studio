-- =============================================================================
-- AI spend ledger — one row per billed OpenRouter call, attributed to a client.
--
-- WHY A LOCAL LEDGER AT ALL
--
-- Every AI feature in this app bills OpenRouter credits (text generation routes
-- through ANTHROPIC_BASE_URL=https://openrouter.ai/api, images and research go
-- straight at the chat-completions endpoint). OpenRouter already tells us what
-- each call cost — `usage.cost` comes back on every response and is the ACTUAL
-- billed USD, not an estimate we invent. What OpenRouter cannot tell us is
-- WHOSE call it was: its books are per-key, and this app uses one key for
-- everybody.
--
-- So each request is tagged with the OpenRouter `user` field (client_<uuid>,
-- see server/usage.js) AND its reported cost is written here. That gives two
-- independent sources for the same number:
--
--   this table                      always available, exact per client,
--                                   starts from the day this migration lands
--   OpenRouter analytics API        authoritative (it is their invoice), needs
--                                   a management key, groups by the same tag
--
-- The Users & access page reads the analytics API when a management key is
-- configured and falls back to this table otherwise — see /api/usage/spend.
--
-- COST IS NULLABLE. A call whose price OpenRouter didn't report is logged with
-- cost_usd = null rather than 0: "we don't know" and "it was free" are
-- different facts and a spend column must not present the first as the second.
-- =============================================================================

create table if not exists public.ai_usage (
  -- bigint identity rather than uuid: append-only log, nothing references these
  -- rows, and a monotonic key indexes tighter.
  id                bigint generated always as identity primary key,

  -- Who the spend belongs to. NULL only for work that genuinely has no client
  -- yet (brand extraction during onboarding runs before the client row exists).
  -- `on delete set null` — not cascade — because deleting a client must not
  -- silently rewrite what was already spent on them.
  client_id         uuid references public.clients (id) on delete set null,
  -- Snapshot so a deleted client's spend still has a label in the ledger.
  client_name       text,

  -- The signed-in user who triggered the call. NULL for cron-driven work
  -- (/api/cron/stream-refresh has a shared secret, not a user JWT).
  user_id           uuid,
  user_email        text,

  -- Short route label: post-copy, post-copy-from-image, image-gen,
  -- idea-suggestions, stream-research, brand-extract, …
  feature           text not null default 'other',

  provider          text not null default 'openrouter',
  model             text,

  -- Actual billed USD. numeric(12,6) — a single Haiku call lands around
  -- $0.0008, so anything coarser than 6 decimal places rounds real spend to
  -- zero. NULL = the provider reported no cost for this call.
  cost_usd          numeric(12,6),
  -- How we know the number, so a mixed total can be read honestly:
  --   openrouter.usage.cost  OpenRouter's own billed figure (preferred)
  --   estimate.tokens        priced from token counts against a rate table
  cost_source       text,

  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer,

  -- One row can cover several billed units (the image studio generates n
  -- images in one user action), so requests is explicit rather than implied.
  requests          integer not null default 1,

  -- OpenRouter's generation id, for reconciling a row against their dashboard
  -- or the /generations API. Null for the Agent-SDK path, which doesn't expose it.
  generation_id     text,

  created_at        timestamptz not null default now()
);

-- Serves the main read (spend per client, newest first) and the time window.
create index if not exists ai_usage_client_created_idx
  on public.ai_usage (client_id, created_at desc);
create index if not exists ai_usage_created_idx
  on public.ai_usage (created_at desc);

-- Server-only, same posture as photos / ideas / social_posts: the Express API
-- holds the service-role key (which bypasses RLS), and enabling RLS with no
-- policies denies every direct anon/browser read. Spend is admin data — it must
-- never be reachable from a client-side Supabase call.
alter table public.ai_usage enable row level security;


-- ---------------------------------------------------------------------------
-- Aggregate read. A view can't take the time window the page wants, and
-- pulling every row back to Node to sum it in JS gets slower every month, so
-- the grouping stays in Postgres.
--
-- p_since = null means all time.
--
-- calls vs requests: calls is rows (user actions), requests is billed units.
-- cost_usd sums only the rows that HAVE a cost; unpriced_calls counts the rest
-- so the caller can tell "$0.42 across 300 calls" from "$0.42, plus 40 calls we
-- couldn't price".
-- ---------------------------------------------------------------------------
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
    -- count(*) is already bigint; casting it would put a `::` next to the
    -- FILTER clause for no reason.
    count(*)                                     as calls,
    count(*) filter (where u.cost_usd is null)   as unpriced_calls,
    max(u.created_at)                            as last_used_at
  from public.ai_usage u
  where p_since is null or u.created_at >= p_since
  group by u.client_id
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC by default, and Supabase
-- exposes it over PostgREST to anon/authenticated. This function reads spend
-- across every client, so lock it to the server's service-role identity —
-- revoking PUBLIC as well, or the blanket grant would keep both roles in.
revoke all on function public.ai_spend_by_client(timestamptz) from public;
revoke all on function public.ai_spend_by_client(timestamptz) from anon, authenticated;
grant execute on function public.ai_spend_by_client(timestamptz) to service_role;

-- Supabase reloads PostgREST's schema cache on DDL automatically, but the RPC
-- 404s until it does. Nudging it makes the endpoint work on the first call
-- after this runs instead of after the next reload.
notify pgrst, 'reload schema';
