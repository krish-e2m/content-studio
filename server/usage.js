// =============================================================================
// server/usage.js
// Per-client AI spend: who is burning the OpenRouter credits.
//
// TWO HALVES
//
//   1. TAG + RECORD. Every OpenRouter call carries a `user` field naming the
//      client it was made for (client_<uuid>), and its reported cost is written
//      to the ai_usage ledger. OpenRouter's own books are per-KEY and this app
//      uses one key for the whole agency, so without the tag there is no way to
//      tell one client's spend from another's.
//
//   2. READ BACK. /api/usage/spend asks OpenRouter's analytics API for spend
//      grouped by that same tag when a management key is configured (their
//      numbers are the invoice), and falls back to the local ledger otherwise.
//
// HOW THE CLIENT ID REACHES A CALL DEEP IN THE STACK
//
// It doesn't get threaded through. chatComplete sits five frames below the
// route in some paths (route → generatePostContent → engine → runQuery), and
// adding a clientId parameter to every signature on the way down would touch
// every AI module to serve bookkeeping, then quietly under-report the first
// time someone added a call site and forgot the extra argument.
//
// Instead the request scope is carried in an AsyncLocalStorage: `trackUsage`
// middleware opens it once per request from req.params/req.auth, and any
// OpenRouter call made anywhere inside that request reads it. New call sites
// are attributed automatically.
// =============================================================================
import './load-env.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { supabase } from './db.js'
import { log } from './logger.js'

const scope = new AsyncLocalStorage()

// { clientId, userId, userEmail, feature } — null outside a tracked request.
export const currentUsage = () => scope.getStore() || null

// Run `fn` with the current scope shallow-merged with `patch`. Merging rather
// than replacing matters for the cron path: refreshStreamForClient adds the
// clientId it resolved without dropping whatever the caller established.
export function withUsage(patch, fn) {
  const next = { ...(scope.getStore() || {}), ...(patch || {}) }
  return scope.run(next, fn)
}

// Route → the short label stored on each ledger row. The explicit list keeps
// the labels stable and readable ("post-copy", not "generate-content"); the
// fallback strips /api/ and any uuid so an unlisted AI route still lands
// somewhere sensible instead of all piling into "other".
const FEATURES = [
  [/\/generate-content-image$/, 'post-copy-from-image'],
  [/\/generate-content$/, 'post-copy'],
  [/\/images\/generate$/, 'image-gen'],
  [/\/research-topics\/[^/]+\/suggest$/, 'idea-suggestions'],
  [/\/stream\/generate$/, 'stream-research'],
  [/\/cron\/stream-refresh$/, 'stream-research'],
  [/\/brand\/extract(-pdf)?$/, 'brand-extract'],
]
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function featureForPath(path) {
  const p = String(path || '')
  for (const [re, label] of FEATURES) if (re.test(p)) return label
  const tail = p
    .replace(/^\/api\//, '')
    .split('/')
    .filter((s) => s && !UUID_RE.test(s))
    .slice(-2)
    .join('-')
  return tail || 'other'
}

// Express middleware. Mounted where req.params.clientId exists (per-client
// routes) and again bare (for /api/brand/*, which has no client yet).
//
// next() is called synchronously inside scope.run, and Express runs the rest of
// the chain from inside that call, so the whole request — including the async
// handler — sees this store.
export function trackUsage(req, _res, next) {
  withUsage(
    {
      clientId: req.params?.clientId || req.params?.id || null,
      userId: req.auth?.id || null,
      userEmail: req.auth?.email || '',
      feature: featureForPath(req.originalUrl?.split('?')[0] || req.path),
    },
    next,
  )
}

// --- the OpenRouter `user` tag -----------------------------------------------
// Sent on every chat-completions request. OpenRouter surfaces it on the
// activity page, in activity exports, and as the `user` dimension of the
// analytics API — which is what makes per-client spend answerable from their
// side and not just ours. Underscore-separated (their documented convention)
// and stable per client, never per request.
export const CLIENT_TAG = 'client_'
export const USER_TAG = 'user_'

export function usageTag(ctx = currentUsage()) {
  if (!ctx) return undefined
  if (ctx.clientId) return `${CLIENT_TAG}${ctx.clientId}`
  // No client (onboarding brand extraction): still attribute it to the person
  // who triggered it rather than losing the spend entirely.
  if (ctx.userId) return `${USER_TAG}${ctx.userId}`
  return undefined
}

// analytics `user` value → the client id it stands for, or null.
export const clientIdFromTag = (tag) => {
  const s = String(tag || '')
  return s.startsWith(CLIENT_TAG) ? s.slice(CLIENT_TAG.length) : null
}

// --- writing the ledger ------------------------------------------------------

// client id → name, so every ledger row carries a label without the routes
// having to pass one down. A client's name is stable and the map is small, so
// it's cached for the life of the process; a miss (or a deleted client) simply
// leaves the snapshot null.
const clientNames = new Map()

async function resolveClientName(clientId) {
  if (!clientId) return null
  if (clientNames.has(clientId)) return clientNames.get(clientId)
  try {
    const { data } = await supabase.from('clients').select('name').eq('id', clientId).single()
    const name = data?.name || null
    clientNames.set(clientId, name)
    return name
  } catch {
    return null
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null)

// The ledger table is optional — a project may not have applied the migration
// yet. What must NOT happen is latching "missing" for the life of the process:
// that turns applying the migration into "applying the migration AND restarting
// the server", and silently drops every call in between. So keep attempting the
// insert every time and only rate-limit the WARNING, which is the thing that
// would otherwise repeat once per generation.
const MISSING_WARN_EVERY_MS = 10 * 60 * 1000
let lastMissingWarnAt = 0

const isMissingLedger = (error) =>
  /ai_usage|ai_spend_by_client/i.test(error?.message || '') &&
  /does not exist|not find|schema cache|relation/i.test(error?.message || '')

// Record one billed call. Deliberately NOT awaited by callers: a generation
// must never fail, or wait, because bookkeeping did. Every failure is swallowed
// after a log line — this is a spend report, not a transaction.
export function recordUsage({
  feature,
  model,
  provider = 'openrouter',
  costUsd,
  costSource,
  usage = {},
  requests = 1,
  generationId,
  clientId,
  userId,
  userEmail,
} = {}) {
  const ctx = currentUsage() || {}
  const forClient = clientId ?? ctx.clientId ?? null
  const row = {
    client_id: forClient,
    user_id: userId ?? ctx.userId ?? null,
    user_email: userEmail ?? ctx.userEmail ?? null,
    feature: feature || ctx.feature || 'other',
    provider,
    model: model || null,
    cost_usd: num(costUsd),
    cost_source: costSource || (num(costUsd) == null ? null : 'openrouter.usage.cost'),
    prompt_tokens: int(usage.prompt_tokens ?? usage.input_tokens),
    completion_tokens: int(usage.completion_tokens ?? usage.output_tokens),
    total_tokens: int(usage.total_tokens),
    requests: Math.max(1, int(requests) || 1),
    generation_id: generationId || null,
  }

  resolveClientName(forClient)
    .then((name) => supabase.from('ai_usage').insert({ ...row, client_name: name }))
    .then(({ error }) => {
      if (!error) return
      if (isMissingLedger(error)) {
        if (Date.now() - lastMissingWarnAt > MISSING_WARN_EVERY_MS) {
          lastMissingWarnAt = Date.now()
          log.warn('[usage] ai_usage table is missing — apply supabase/migrations/20260820120000_create_ai_usage.sql; spend reads as unavailable until then')
        }
        return
      }
      log.warn('[usage] could not record spend', { message: error.message, feature: row.feature })
    })
    .catch((e) => log.warn('[usage] could not record spend', { message: e?.message }))
}

// --- reading the ledger ------------------------------------------------------

// Per-client totals from our own rows. { ready, rows } — ready:false means the
// migration hasn't been applied, which the endpoint reports rather than
// presenting as "$0.00 spent".
export async function ledgerSpendByClient({ since = null } = {}) {
  const { data, error } = await supabase.rpc('ai_spend_by_client', { p_since: since })
  if (error) {
    if (isMissingLedger(error)) return { ready: false, rows: [] }
    throw new Error(error.message)
  }
  return {
    ready: true,
    rows: (data || []).map((r) => ({
      clientId: r.client_id || null,
      costUsd: Number(r.cost_usd) || 0,
      requests: Number(r.requests) || 0,
      calls: Number(r.calls) || 0,
      unpricedCalls: Number(r.unpriced_calls) || 0,
      lastUsedAt: r.last_used_at || null,
    })),
  }
}

// --- OpenRouter's own books --------------------------------------------------
// Both endpoints below need a MANAGEMENT key (openrouter.ai/settings/
// management-keys), not the inference key the app generates with — an
// inference key gets a 403. Without one configured these return null and the
// endpoint falls back to the ledger.

function apiBase() {
  // Same env the inference client reads, normalised to the /v1 root.
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://openrouter.ai/api').replace(/\/+$/, '')
  return /\/v1$/.test(base) ? base : `${base}/v1`
}

const managementKey = () => process.env.OPENROUTER_MANAGEMENT_KEY || ''
export const hasManagementKey = () => Boolean(managementKey())

async function orFetch(path, init = {}, timeoutMs = 15000) {
  const key = managementKey()
  if (!key) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const r = await fetch(`${apiBase()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new Error(`OpenRouter ${path} ${r.status}: ${body.slice(0, 200)}`)
    }
    return await r.json()
  } finally {
    clearTimeout(timer)
  }
}

// Account-level credits: what has been bought and what is left. This is the
// whole key's balance, not a per-client figure.
export async function openRouterCredits() {
  try {
    const json = await orFetch('/credits', { method: 'GET' })
    if (!json) return null
    const d = json.data || json
    const purchased = num(d.total_credits)
    const used = num(d.total_usage)
    return {
      purchased,
      used,
      remaining: purchased != null && used != null ? purchased - used : null,
    }
  } catch (e) {
    log.warn('[usage] OpenRouter credits lookup failed', { message: e.message })
    return null
  }
}

// Spend grouped by the `user` tag we send — OpenRouter's own accounting of who
// spent what. Returns null when there is no management key or the call fails,
// so the caller can fall back rather than show an error in a table column.
export async function openRouterSpendByUser({ since = null } = {}) {
  if (!hasManagementKey()) return null
  // All-time still needs a bounded range; 2024 predates this project.
  const start = since || '2024-01-01T00:00:00Z'
  const end = new Date().toISOString()
  try {
    const json = await orFetch('/analytics/query', {
      method: 'POST',
      body: JSON.stringify({
        metrics: ['total_usage', 'request_count'],
        dimensions: ['user'],
        time_range: { start, end },
        order_by: { field: 'total_usage', direction: 'desc' },
        limit: 500,
      }),
    })
    if (!json) return null
    // { data: { data: [ { user, total_usage, request_count } ], metadata: {…} } }
    const payload = json.data || {}
    const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : []
    if (payload.metadata?.truncated) {
      log.warn('[usage] OpenRouter analytics response was truncated — per-client spend may be partial')
    }
    return rows
      .map((r) => ({
        tag: String(r.user || ''),
        clientId: clientIdFromTag(r.user),
        costUsd: Number(r.total_usage) || 0,
        requests: Number(r.request_count) || 0,
      }))
      .filter((r) => r.tag)
  } catch (e) {
    log.warn('[usage] OpenRouter analytics query failed', { message: e.message })
    return null
  }
}
