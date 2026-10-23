import './load-env.js'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { supabase, supabaseAuth } from './db.js'
import {
  requireAuth, requireAdmin, requireClientAccess, requireCronSecret, resolveUser, visibleClients,
  listAllAuthUsers, patchUserMetadata, toUserRow,
} from './auth.js'
import { extractBrandFromSite, extractBrandFromPdf } from './brand.js'
import { draftCoreDocs } from './brandfiles.js'
import { suggestIdeasForTopic, suggestStreamTopics, headlineSig, STREAM_MAX } from './suggest.js'
import { generatePostContent, generatePostContentFromImage } from './generate.js'
import { generateImages, decodeDataUrl } from './images.js'
import { router as extractionRouter } from './extractor/routes.js'
import { normalizeUrl } from './url.js'
import { readFileSync, existsSync } from 'node:fs'
import { join as pathJoin } from 'node:path'
import { fetchPlatform, bareHandle, SUPPORTED_PLATFORMS, COMMENTS_PER_POST, APIFY_ACTORS } from './apify.js'
import { saveSnapshot, saveError, commitChannelStats, getLatest, getHistory, clearClient } from './socialStore.js'
import { log, LOG_DIR } from './logger.js'
import {
  trackUsage, withUsage, ledgerSpendByClient, openRouterCredits, openRouterSpendByUser, hasManagementKey,
} from './usage.js'

const app = express()
app.use(cors())
// Generous limit: AI image save/generate payloads carry base64 data-URLs
// (generated images + any uploaded reference images) in the JSON body.
app.use(express.json({ limit: '16mb' }))

const PORT = process.env.PORT || 4000

// in-memory upload (files are streamed straight to Supabase Storage)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })

// Storage buckets: reference docs (PDFs) + client logos + photo library.
const DOCS_BUCKET = 'ref-documents'
const LOGO_BUCKET = 'client-logos'
const PHOTOS_BUCKET = 'client-photos'
const readyBuckets = new Set()
async function ensureBucket(name) {
  if (readyBuckets.has(name)) return
  const { data } = await supabase.storage.getBucket(name)
  if (!data) {
    const { error } = await supabase.storage.createBucket(name, { public: true })
    if (error && !/already exists/i.test(error.message)) throw new Error(error.message)
  }
  readyBuckets.add(name)
}

// public storage URL → the object path inside a bucket (for deletion)
function storagePathFromUrl(url, bucket) {
  const marker = `/object/public/${bucket}/`
  const s = String(url || '')
  const i = s.indexOf(marker)
  return i === -1 ? '' : s.slice(i + marker.length).split('?')[0]
}

// website url → bare domain (strip protocol / www / path)
function domainOf(input) {
  let s = String(input || '').trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s
  try {
    return new URL(s).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

// Carry scraped `stats` (followers, engagement rate, mirrored avatar — written
// by socialStore) from the stored channel entries onto an incoming edit, which
// only ever carries config. Stats are dropped for a platform that has been
// removed, and for one whose handle changed, since the old figures describe a
// different account.
async function mergeChannelStats(clientId, incoming) {
  if (!Array.isArray(incoming)) return incoming
  const { data } = await supabase
    .from('clients').select('social_media_accounts').eq('id', clientId).single()
  const prev = Array.isArray(data?.social_media_accounts) ? data.social_media_accounts : []
  if (!prev.length) return incoming

  const key = (e) => `${String(e?.platform || '').toLowerCase()}::${String(e?.handle || '').toLowerCase()}`
  const statsByKey = new Map(prev.filter((e) => e?.stats).map((e) => [key(e), e.stats]))

  return incoming.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry
    const stats = statsByKey.get(key(entry))
    return stats ? { ...entry, stats } : entry
  })
}

// Normalize the `url` on each social account, leaving every other field (and
// non-object entries) untouched. Shape-safe: passes non-arrays straight through.
function normalizeSocials(accounts) {
  if (!Array.isArray(accounts)) return accounts
  return accounts.map((s) =>
    s && typeof s === 'object' ? { ...s, url: normalizeUrl(s.url) } : s,
  )
}

const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
}

// Photo Library accepts ONLY these raster image formats - nothing else. SVG is
// deliberately excluded (it can carry scripts), as are exotic formats (heic,
// tiff, bmp, …). An upload must pass BOTH the mimetype and the file-extension
// check, so a mislabeled or renamed file is rejected.
const PHOTO_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'])
const PHOTO_EXT = /\.(jpe?g|png|webp|gif)$/i
const PHOTO_TYPES_LABEL = 'JPG, JPEG, PNG, WEBP or GIF'
const isAllowedPhoto = (file) =>
  PHOTO_MIME.has(String(file?.mimetype || '').toLowerCase()) && PHOTO_EXT.test(file?.originalname || '')

// --- helpers ---------------------------------------------------------------

const slugify = (s) =>
  String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// Slug is a server-generated random id (NOT derived from the name, not editable).
const randomSlug = () => randomBytes(6).toString('hex') // 12 hex chars

// Brand documents are stored as an array of { name, content } (content is raw
// markdown). Coerce to that shape and drop anything else / empty rows.
function sanitizeDocuments(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((d) => ({
      name: typeof d?.name === 'string' ? d.name.trim() : '',
      content: typeof d?.content === 'string' ? d.content : '',
      tag: typeof d?.tag === 'string' ? d.tag.trim() : '',
    }))
    .filter((d) => d.name || d.content)
}

// Whitelist exactly the columns a client may set, so they can't push
// id/slug/created_at or arbitrary fields. slug is assigned by the server.
function sanitizeClient(body = {}) {
  return {
    name: typeof body.name === 'string' ? body.name.trim() : '',
    contact_name: body.contact_name ?? null,
    tagline: body.tagline ?? null,
    industry: body.industry ?? null,
    website_url: body.website_url == null ? null : normalizeUrl(body.website_url),
    status: body.status || 'onboarding',
    social_media_accounts: normalizeSocials(body.social_media_accounts),
    ref_documents: body.ref_documents,
    documents: sanitizeDocuments(body.documents),
  }
}

// Idea Bank: whitelist the columns the "Add an idea" form may set. priority is
// nullable (empty -> null so it passes the CHECK), and tags/platforms are coerced
// to clean string arrays. client_id is taken from the URL, never the body. Column
// names mirror the ideas table.
const IDEA_PRIORITIES = ['High', 'Medium', 'Low']
const strArray = (v) =>
  Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []

function sanitizeIdea(body = {}) {
  const platforms = strArray(body.platforms)
  const contentType = body.content_type && typeof body.content_type === 'object' && !Array.isArray(body.content_type)
    ? Object.fromEntries(Object.entries(body.content_type).filter(([k, v]) => typeof k === 'string' && typeof v === 'string'))
    : {}
  const refImages = Array.isArray(body.ref_images)
    ? body.ref_images
        .filter((x) => x && typeof x.url === 'string' && x.url)
        .map((x) => ({ id: x.id ?? null, url: x.url, title: typeof x.title === 'string' ? x.title : '' }))
    : []
  return {
    title: typeof body.title === 'string' ? body.title.trim() : '',
    description: typeof body.description === 'string' ? body.description.trim() : '',
    audience: typeof body.audience === 'string' ? body.audience.trim() : '',
    priority: IDEA_PRIORITIES.includes(body.priority) ? body.priority : null,
    tags: strArray(body.tags),
    draft_link: body.draft_link ? normalizeUrl(body.draft_link) : null,
    platforms: platforms.length ? platforms : ['linkedin'],
    content_type: contentType,
    ref_images: refImages,
  }
}

// True when a write failed only because the content_type / ref_images columns
// aren't in the DB yet (migration not applied). Lets us retry without them so
// idea saving never breaks in the meantime.
const IDEA_EXTRA_COLS = ['content_type', 'ref_images']
const isMissingIdeaColumn = (e) =>
  !!e && (e.code === 'PGRST204' || e.code === '42703' ||
    IDEA_EXTRA_COLS.some((c) => (e.message || '').includes(c)))
const withoutIdeaExtras = (row) => {
  const { content_type, ref_images, ...rest } = row
  return rest
}

const isObject = (v) => v !== null && typeof v === 'object'

// Posts (unified drafts + finalized). Identity is the row id; the whole wizard
// state lives in the `state` jsonb blob (platform-keyed), including the source
// idea id. A draft is created on first save and updated by id thereafter.
const POST_STATUSES = ['draft', 'scheduled', 'published']
const str = (v) => (typeof v === 'string' ? v.trim() : '')

// wrap async handlers so thrown errors hit the error middleware
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

// --- routes ----------------------------------------------------------------

app.get('/api/health', (_req, res) => res.json({ ok: true }))

// Entry point for both callers. The AI-spend scope is opened HERE rather than
// left to the route middleware because this also runs from
// /api/cron/stream-refresh, which authenticates with a shared secret and has no
// req.params.clientId — without this, every cron-driven research call would
// bill to nobody. withUsage merges, so the per-client route's own scope (the
// signed-in user) survives.
const refreshStreamForClient = (clientId) =>
  withUsage({ clientId, feature: 'stream-research' }, () => runStreamRefresh(clientId))

// Fetch + insert new stream research topics for one client. Skips headlines
// that already exist (by loose signature), then keeps only the newest
// STREAM_MAX rows so the Stream tab never piles past 5. Returns
// { ok, clientId, name, added, topics } or { ok:false, error, status }.
async function runStreamRefresh(clientId) {
  const max = STREAM_MAX()
  const { data: client, error: cErr } = await supabase
    .from('clients')
    .select('id, name, industry, tagline, website_url, ref_documents')
    .eq('id', clientId)
    .single()
  if (cErr || !client) {
    return { ok: false, clientId, error: 'client not found', status: 404 }
  }

  // Only the titles we still keep — enough to de-dupe, cheap on prompt tokens.
  const { data: existing } = await supabase
    .from('research_topics')
    .select('id, title')
    .eq('client_id', clientId)
    .eq('source', 'stream')
    .order('created_at', { ascending: false })
    .limit(max)
  const excludeTitles = (existing || []).map((r) => r.title).filter(Boolean)

  const topics = await suggestStreamTopics(client, { excludeTitles })

  // Belt-and-suspenders: drop anything that still matches an existing signature
  // even if the model ignored the exclude list.
  const seen = new Set(excludeTitles.map(headlineSig).filter(Boolean))
  const fresh = []
  for (const title of topics) {
    const sig = headlineSig(title)
    if (!sig || seen.has(sig)) continue
    seen.add(sig)
    fresh.push(title)
    if (fresh.length >= max) break
  }

  let inserted = []
  if (fresh.length) {
    const inserts = fresh.map((title) => ({
      client_id: clientId,
      title,
      source: 'stream',
    }))
    const { data, error } = await supabase.from('research_topics').insert(inserts).select()
    if (error) return { ok: false, clientId, name: client.name, error: error.message, status: 500 }
    inserted = data || []
  }

  // Cap the list at STREAM_MAX newest rows (drops older ones after a refresh).
  const { data: all } = await supabase
    .from('research_topics')
    .select('id')
    .eq('client_id', clientId)
    .eq('source', 'stream')
    .order('created_at', { ascending: false })
  const extraIds = (all || []).slice(max).map((r) => r.id)
  if (extraIds.length) {
    await supabase.from('research_topics').delete().in('id', extraIds)
  }

  return {
    ok: true,
    clientId,
    name: client.name,
    added: inserted.length,
    pruned: extraIds.length,
    topics: inserted,
    fetched: topics.length,
  }
}

// Daily (or on-demand) stream refresh for external cron jobs.
// Auth: Authorization: Bearer <CRON_SECRET>  OR  x-cron-secret: <CRON_SECRET>
// Optional body/query: { clientId } to refresh a single client; otherwise all.
app.post(
  '/api/cron/stream-refresh',
  requireCronSecret,
  h(async (req, res) => {
    const clientId = req.body?.clientId || req.query?.clientId || null

    let clients
    if (clientId) {
      const { data, error } = await supabase
        .from('clients')
        .select('id, name')
        .eq('id', clientId)
        .maybeSingle()
      if (error) return res.status(500).json({ error: error.message })
      if (!data) return res.status(404).json({ error: 'client not found' })
      clients = [data]
    } else {
      const { data, error } = await supabase
        .from('clients')
        .select('id, name')
        .order('created_at', { ascending: false })
      if (error) return res.status(500).json({ error: error.message })
      clients = data || []
    }

    const results = []
    for (const c of clients) {
      try {
        const result = await refreshStreamForClient(c.id)
        results.push(result)
      } catch (e) {
        results.push({ ok: false, clientId: c.id, name: c.name, error: e.message || 'failed' })
      }
    }

    const totals = {
      clients: results.length,
      added: results.reduce((n, r) => n + (r.added || 0), 0),
      failed: results.filter((r) => !r.ok).length,
    }
    res.json({ ok: totals.failed === 0, totals, results })
  }),
)

// =============================================================================
// Auth
// Identity lives in Supabase Auth; this exchanges a password for a token and
// reports the caller's role + assigned clients. The client stores the token and
// sends it as `Authorization: Bearer`.
// =============================================================================
app.post(
  '/api/auth/login',
  h(async (req, res) => {
    const email = str(req.body?.email).toLowerCase()
    const password = str(req.body?.password)
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' })

    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password })
    // Deliberately vague: don't reveal whether the address exists.
    if (error || !data?.session) return res.status(401).json({ error: 'Wrong email or password' })

    const user = await resolveUser(data.session.access_token)
    if (!user) {
      return res.status(403).json({ error: 'This account has no workspace access yet. Ask an admin to add you.' })
    }
    res.json({ token: data.session.access_token, refreshToken: data.session.refresh_token, user })
  }),
)

// Restore a session on page load.
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.auth }))

// Exchange a refresh token for a fresh access token so the client can stay
// signed in across page reloads / JWT expiry until the user explicitly logs out.
app.post(
  '/api/auth/refresh',
  h(async (req, res) => {
    const refreshToken = str(req.body?.refreshToken)
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' })

    const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken })
    if (error || !data?.session) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' })
    }

    const user = await resolveUser(data.session.access_token)
    if (!user) {
      return res.status(403).json({ error: 'This account has no workspace access yet. Ask an admin to add you.' })
    }
    res.json({
      token: data.session.access_token,
      refreshToken: data.session.refresh_token,
      user,
    })
  }),
)

// =============================================================================
// Users (admin only)
//
// There is no users table: identity, role and client assignments all live in
// auth.users.raw_user_meta_data. See server/auth.js for the shape.
// =============================================================================
app.get(
  '/api/users',
  requireAuth,
  requireAdmin,
  h(async (_req, res) => {
    const users = await listAllAuthUsers()
    // Only surface accounts that have actually been granted access; a stray
    // Supabase signup with no flags isn't a workspace member.
    res.json(
      users
        .map(toUserRow)
        .filter((u) => u.role === 'admin' || u.role === 'user')
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    )
  }),
)

// Create a login. The metadata stamp is what grants access:
//   { is_user: true, full_name, client_ids: [...] }
app.post(
  '/api/users',
  requireAuth,
  requireAdmin,
  h(async (req, res) => {
    const email = str(req.body?.email).toLowerCase()
    const password = str(req.body?.password)
    const fullName = str(req.body?.fullName)
    const clientIds = strArray(req.body?.clientIds)

    if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required' })
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        is_user: true,
        full_name: fullName || null,
        client_ids: clientIds,
      },
    })
    if (error) {
      const dupe = /already|registered|exists/i.test(error.message || '')
      return res.status(dupe ? 409 : 500).json({ error: dupe ? 'That email already has an account' : error.message })
    }
    res.status(201).json(toUserRow(data.user))
  }),
)

// Replace a user's client assignments (metadata is merged, not clobbered).
app.put(
  '/api/users/:userId/clients',
  requireAuth,
  requireAdmin,
  h(async (req, res) => {
    const { userId } = req.params
    const clientIds = strArray(req.body?.clientIds)

    const { data: existing, error: getErr } = await supabase.auth.admin.getUserById(userId)
    if (getErr || !existing?.user) return res.status(404).json({ error: 'User not found' })
    if ((existing.user.user_metadata || {}).is_admin === true) {
      return res.status(400).json({ error: 'Admins already see every client' })
    }

    const updated = await patchUserMetadata(userId, { is_user: true, client_ids: clientIds })
    res.json(toUserRow(updated))
  }),
)

app.delete(
  '/api/users/:userId',
  requireAuth,
  requireAdmin,
  h(async (req, res) => {
    const { userId } = req.params
    if (userId === req.auth.id) return res.status(400).json({ error: "You can't remove your own account" })
    const { error } = await supabase.auth.admin.deleteUser(userId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  }),
)

// =============================================================================
// AI spend (admin only)
//
// Answers "who is burning the OpenRouter credits" for the Users & access table.
// Two sources, reported side by side rather than blended:
//
//   ledger    ai_usage rows — every call this app made, with the cost
//             OpenRouter reported for it. COMPLETE, because it also captures
//             the Claude Agent SDK text path, which has no way to carry
//             OpenRouter's `user` tag. This is what the spend column shows.
//   openRouter  the same spend as OpenRouter itself groups it (analytics API,
//             by the `user` tag we send). Their books, so it settles any doubt
//             about our arithmetic — but it only sees tagged calls, and needs a
//             management key. Null when neither holds.
//
// A missing figure is reported as null, never as 0: "nothing spent" and "we
// can't tell yet" must not render the same.
// =============================================================================
app.get(
  '/api/usage/spend',
  requireAuth,
  requireAdmin,
  h(async (req, res) => {
    const days = Number(req.query?.days)
    const since = Number.isFinite(days) && days > 0
      ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
      : null   // all time

    // None of the three may take the page down: a spend column is useful even
    // when one source is unreachable, so each failure degrades to null.
    const [ledger, remote, credits] = await Promise.all([
      ledgerSpendByClient({ since }).catch((e) => {
        log.warn('[usage] ledger read failed', { message: e.message })
        return { ready: false, rows: [] }
      }),
      openRouterSpendByUser({ since }),
      openRouterCredits(),
    ])

    const byClient = {}
    const entry = (id) =>
      (byClient[id] ||= { costUsd: 0, requests: 0, calls: 0, unpricedCalls: 0, lastUsedAt: null, openRouterCostUsd: null })

    let unassigned = null
    for (const r of ledger.rows) {
      // client_id null = work with no client yet (onboarding brand extraction),
      // or a client that has since been deleted.
      if (!r.clientId) {
        unassigned = { costUsd: r.costUsd, requests: r.requests, calls: r.calls }
        continue
      }
      Object.assign(entry(r.clientId), {
        costUsd: r.costUsd,
        requests: r.requests,
        calls: r.calls,
        unpricedCalls: r.unpricedCalls,
        lastUsedAt: r.lastUsedAt,
      })
    }
    for (const r of remote || []) {
      if (r.clientId) entry(r.clientId).openRouterCostUsd = r.costUsd
    }

    const rows = Object.values(byClient)
    res.json({
      ready: ledger.ready,
      since,
      byClient,
      unassigned,
      total: {
        costUsd: rows.reduce((n, r) => n + r.costUsd, 0) + (unassigned?.costUsd || 0),
        requests: rows.reduce((n, r) => n + r.requests, 0) + (unassigned?.requests || 0),
      },
      // Account-wide credit balance for the whole key — context for the totals
      // above, not a per-client number.
      credits,
      openRouterAvailable: Array.isArray(remote),
      managementKey: hasManagementKey(),
    })
  }),
)

// =============================================================================
// Everything below requires a signed-in caller, and every per-client route is
// additionally scoped to the caller's assignments.
// =============================================================================
app.use('/api/clients', requireAuth)
app.use('/api/clients/:clientId', requireClientAccess)
// Opens the per-request AI-spend scope (see server/usage.js). Mounted right
// after the access check so every AI call under a client — however deep in the
// stack — is billed to that client without threading an id through it.
app.use('/api/clients/:clientId', trackUsage)
app.use('/api/brand', requireAuth)
// Brand extraction runs before a client row exists, so this scope carries only
// the acting user; its spend shows up as unassigned rather than vanishing.
app.use('/api/brand', trackUsage)
app.use('/api/uploads', requireAuth)
app.use('/api/logo', requireAuth)
app.use('/api/logs', requireAuth)

app.post(
  '/api/logs',
  h(async (req, res) => {
    const level = String(req.body?.level || 'info').toLowerCase()
    const message = String(req.body?.message || '').slice(0, 2000)
    const extra = req.body?.extra
    const source = String(req.body?.source || 'client').slice(0, 40)
    if (!message) return res.status(400).json({ error: 'message is required' })
    const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'
    log[fn](`[${source}] ${message}`, extra)
    res.json({ ok: true, logDir: LOG_DIR })
  }),
)

app.get(
  '/api/logs/today',
  h(async (_req, res) => {
    const today = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const name = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.log`
    const file = pathJoin(LOG_DIR, name)
    if (!existsSync(file)) {
      return res.json({ file: name, logDir: LOG_DIR, lines: [], note: 'No log file yet — restart the server so logging initializes.' })
    }
    const raw = readFileSync(file, 'utf8')
    const lines = raw.trim().split('\n').filter(Boolean)
    res.json({ file: name, logDir: LOG_DIR, lines: lines.slice(-200) })
  }),
)

// upload a reference document → Supabase Storage, foldered per client (slug).
// returns { title, path, url } to store inside a client's ref_documents.
app.post(
  '/api/uploads',
  upload.single('file'),
  h(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file is required' })
    const isPdf =
      req.file.mimetype === 'application/pdf' || /\.pdf$/i.test(req.file.originalname)
    if (!isPdf) return res.status(400).json({ error: 'Only PDF files are allowed' })
    await ensureBucket(DOCS_BUCKET)
    const slug = slugify(req.body.slug) || 'unfiled'
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')
    const path = `${slug}/${Date.now()}-${safeName}`
    const { error } = await supabase.storage
      .from(DOCS_BUCKET)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false })
    if (error) return res.status(500).json({ error: error.message })
    const { data } = supabase.storage.from(DOCS_BUCKET).getPublicUrl(path)
    res.status(201).json({ title: req.file.originalname, path, url: data.publicUrl })
  }),
)

// fetch a website's logo via manifest.im → store in Storage → return its URL.
app.post(
  '/api/logo',
  h(async (req, res) => {
    const domain = domainOf(req.body.url || req.body.domain)
    if (!domain) return res.status(400).json({ error: 'a valid website url is required' })

    let r
    try {
      r = await fetch(`http://manifest.im/icon/${domain}`, { redirect: 'follow' })
    } catch {
      return res.status(502).json({ error: 'could not reach the logo service' })
    }
    const ct = (r.headers.get('content-type') || '').toLowerCase().split(';')[0].trim()
    if (!r.ok || !ct.startsWith('image/'))
      return res.status(404).json({ error: 'no logo found for this domain' })

    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length) return res.status(404).json({ error: 'empty logo' })

    await ensureBucket(LOGO_BUCKET)
    const ext = EXT_BY_TYPE[ct] || 'png'
    const path = `${domain}/icon.${ext}`
    const { error } = await supabase.storage
      .from(LOGO_BUCKET)
      .upload(path, buf, { contentType: ct, upsert: true })
    if (error) return res.status(500).json({ error: error.message })

    // delete the previous scraped logo if it was a different file (e.g. the
    // website domain changed). Best-effort - ignore failures.
    const prevPath = storagePathFromUrl(req.body.prevUrl, LOGO_BUCKET)
    if (prevPath && prevPath !== path) {
      await supabase.storage.from(LOGO_BUCKET).remove([prevPath])
    }

    const { data } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(path)
    // cache-bust so a re-fetched logo updates immediately
    res.json({ url: `${data.publicUrl}?v=${Date.now()}`, domain })
  }),
)

// manual logo upload (an image file) → Storage → returns its URL.
app.post(
  '/api/logo/upload',
  upload.single('file'),
  h(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file is required' })
    if (!String(req.file.mimetype).startsWith('image/'))
      return res.status(400).json({ error: 'logo must be an image' })
    await ensureBucket(LOGO_BUCKET)
    const folder = slugify(req.body.folder) || 'unfiled'
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')
    const path = `${folder}/manual-${Date.now()}-${safeName}`
    const { error } = await supabase.storage
      .from(LOGO_BUCKET)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false })
    if (error) return res.status(500).json({ error: error.message })
    const { data } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(path)
    res.status(201).json({ url: data.publicUrl, path })
  }),
)

// crawl a website + extract a structured brand identity via Claude Haiku 4.5.
// returns { data: <brand fields + identity>, meta: { pages, colors, fonts } }
app.post(
  '/api/brand/extract',
  h(async (req, res) => {
    const url = normalizeUrl(req.body.url)
    if (!url) return res.status(400).json({ error: 'a website url is required' })
    try {
      const { data, meta } = await extractBrandFromSite(url)
      res.json({ data, meta })
    } catch (e) {
      res.status(502).json({ error: e.message || 'extraction failed' })
    }
  }),
)

// extract a structured brand identity from an uploaded brand-guide PDF via Claude Haiku 4.5.
app.post(
  '/api/brand/extract-pdf',
  upload.single('file'),
  h(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file is required' })
    const isPdf = req.file.mimetype === 'application/pdf' || /\.pdf$/i.test(req.file.originalname)
    if (!isPdf) return res.status(400).json({ error: 'Only PDF files are allowed' })
    try {
      const { data, meta } = await extractBrandFromPdf(req.file.buffer, req.file.originalname)
      res.json({ data, meta })
    } catch (e) {
      res.status(502).json({ error: e.message || 'PDF extraction failed' })
    }
  }),
)

// list all clients (newest first)
app.get(
  '/api/clients',
  h(async (req, res) => {
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    // non-admins only ever receive their assigned clients
    res.json(visibleClients(req.auth, data || []))
  }),
)

// one client
app.get(
  '/api/clients/:id',
  h(async (req, res) => {
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', req.params.id)
      .single()
    if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message })
    res.json(data)
  }),
)

// create a client (the onboarding wizard posts the row here)
app.post(
  '/api/clients',
  requireAdmin,
  h(async (req, res) => {
    const row = sanitizeClient(req.body)

    if (!row.name) return res.status(400).json({ error: 'name is required' })
    if (!Array.isArray(row.social_media_accounts))
      return res.status(400).json({ error: 'social_media_accounts (array) is required' })
    if (!isObject(row.ref_documents))
      return res.status(400).json({ error: 'ref_documents (object) is required' })

    // Assign a random slug; retry a few times if it ever collides.
    let data, error
    for (let attempt = 0; attempt < 5; attempt++) {
      ;({ data, error } = await supabase
        .from('clients')
        .insert({ ...row, slug: randomSlug() })
        .select()
        .single())
      if (!error || error.code !== '23505') break // 23505 = unique_violation
    }
    if (error) return res.status(500).json({ error: error.message })
    res.status(201).json(data)
  }),
)

// update (e.g. edit the Brand Brain later)
app.patch(
  '/api/clients/:id',
  h(async (req, res) => {
    // Only update fields actually present in the body. slug is never editable.
    const allowed = [
      'name', 'contact_name', 'tagline', 'industry', 'website_url',
      'status', 'social_media_accounts', 'ref_documents', 'documents',
    ]
    const patch = {}
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k]
    if ('name' in patch && !String(patch.name).trim())
      return res.status(400).json({ error: 'name cannot be empty' })
    if ('documents' in patch) patch.documents = sanitizeDocuments(patch.documents)
    // normalize any links to a canonical https:// form (bare domains get a scheme)
    if ('website_url' in patch && patch.website_url != null) patch.website_url = normalizeUrl(patch.website_url)
    if ('social_media_accounts' in patch) {
      // Scraped metrics live on these entries under `stats` (see socialStore),
      // but the setup form only ever sends config — platform, handle, url. A
      // straight overwrite would therefore erase every follower count and
      // engagement rate the moment someone edited a handle, so carry the
      // existing stats across for any platform that is still configured.
      patch.social_media_accounts = await mergeChannelStats(
        req.params.id, normalizeSocials(patch.social_media_accounts),
      )
    }
    if (Object.keys(patch).length === 0)
      return res.status(400).json({ error: 'no editable fields provided' })

    const { data, error } = await supabase
      .from('clients')
      .update(patch)
      .eq('id', req.params.id)
      .select()
      .single()
    if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message })
    res.json(data)
  }),
)

// delete
app.delete(
  '/api/clients/:id',
  requireAdmin,   // assigned users may work in a client, not delete it
  h(async (req, res) => {
    // Scraped rows go by FK cascade, but Storage objects never do — sweep the
    // mirrored thumbnails first or they outlive the client indefinitely.
    await clearClient(req.params.id).catch((e) => console.warn('[server] social cleanup:', e.message))
    const { error } = await supabase.from('clients').delete().eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.status(204).end()
  }),
)

// Draft the starter core/*.md brand documents from the structured guideline
// (deterministic templating - see brandfiles.js). Existing documents with the
// same name+tag are never overwritten, so human edits are safe to re-run over.
// Returns { client, added } - the updated client row + how many docs were added.
app.post(
  '/api/clients/:id/brand-files/draft',
  h(async (req, res) => {
    const { data: client, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', req.params.id)
      .single()
    if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message })

    const existing = Array.isArray(client.documents) ? client.documents : []
    const has = new Set(existing.map((d) => `${(d.tag || '').trim().toLowerCase()}/${(d.name || '').trim().toLowerCase()}`))
    const drafts = draftCoreDocs(client).filter((d) => !has.has(`${d.tag.toLowerCase()}/${d.name.toLowerCase()}`))
    if (drafts.length === 0) return res.json({ client, added: 0 })

    const { data: updated, error: uErr } = await supabase
      .from('clients')
      .update({ documents: [...existing, ...drafts] })
      .eq('id', req.params.id)
      .select()
      .single()
    if (uErr) return res.status(500).json({ error: uErr.message })
    res.json({ client: updated, added: drafts.length })
  }),
)

// --- Idea Bank (ideas scoped to a client) ----------------------------------

// list a client's ideas (newest first)
app.get(
  '/api/clients/:clientId/ideas',
  h(async (req, res) => {
    const { data, error } = await supabase
      .from('ideas')
      .select('*')
      .eq('client_id', req.params.clientId)
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  }),
)

// create an idea under a client (the "Add an idea" form posts here)
app.post(
  '/api/clients/:clientId/ideas',
  h(async (req, res) => {
    const row = sanitizeIdea(req.body)
    if (!row.title) return res.status(400).json({ error: 'title is required' })
    const full = { ...row, client_id: req.params.clientId }
    let { data, error } = await supabase.from('ideas').insert(full).select().single()
    // Migration for content_type/ref_images not applied yet — retry without them.
    if (isMissingIdeaColumn(error))
      ({ data, error } = await supabase.from('ideas').insert(withoutIdeaExtras(full)).select().single())
    // 23503 = foreign_key_violation -> the client_id doesn't exist
    if (error) return res.status(error.code === '23503' ? 404 : 500)
      .json({ error: error.code === '23503' ? 'client not found' : error.message })
    res.status(201).json(data)
  }),
)

// update an idea (the edit form posts the full record). Only whitelisted
// columns are written, scoped to the idea's client.
app.patch(
  '/api/clients/:clientId/ideas/:ideaId',
  h(async (req, res) => {
    const allowed = ['title', 'description', 'audience', 'priority', 'tags', 'draft_link', 'platforms', 'content_type', 'ref_images']
    const clean = sanitizeIdea(req.body)
    const patch = {}
    for (const k of allowed) if (k in req.body) patch[k] = clean[k]
    if ('title' in patch && !patch.title) return res.status(400).json({ error: 'title is required' })
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no editable fields provided' })

    const runUpdate = (p) => supabase
      .from('ideas')
      .update(p)
      .eq('id', req.params.ideaId)
      .eq('client_id', req.params.clientId)
      .select()
      .single()
    let { data, error } = await runUpdate(patch)
    // Migration for content_type/ref_images not applied yet — retry without them.
    if (isMissingIdeaColumn(error)) {
      const base = withoutIdeaExtras(patch)
      ;({ data, error } = Object.keys(base).length ? await runUpdate(base) : { data: null, error: null })
    }
    if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message })
    res.json(data)
  }),
)

// delete an idea (scoped to its client so ids can't cross client boundaries)
app.delete(
  '/api/clients/:clientId/ideas/:ideaId',
  h(async (req, res) => {
    const { error } = await supabase
      .from('ideas')
      .delete()
      .eq('id', req.params.ideaId)
      .eq('client_id', req.params.clientId)
    if (error) return res.status(500).json({ error: error.message })
    res.status(204).end()
  }),
)

// --- Research topics (Manual tab of the Research page, scoped to a client) --

// list a client's research topics (newest first). Defaults to open topics only
// (done ones drop out of the active list); pass ?status=done or ?status=all.
app.get(
  '/api/clients/:clientId/research-topics',
  h(async (req, res) => {
    const status = req.query.status || 'open'
    const source = req.query.source || 'manual'
    let q = supabase
      .from('research_topics')
      .select('*')
      .eq('client_id', req.params.clientId)
      .eq('source', source)
      .order('created_at', { ascending: false })
    if (status !== 'all') q = q.eq('status', status)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  }),
)

// update a research topic (used to mark it 'done' once it's been worked)
app.patch(
  '/api/clients/:clientId/research-topics/:topicId',
  h(async (req, res) => {
    const patch = {}
    if ('status' in req.body) {
      if (!['open', 'done'].includes(req.body.status))
        return res.status(400).json({ error: "status must be 'open' or 'done'" })
      patch.status = req.body.status
    }
    if (typeof req.body?.title === 'string' && req.body.title.trim()) patch.title = req.body.title.trim()
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no editable fields provided' })

    const { data, error } = await supabase
      .from('research_topics')
      .update(patch)
      .eq('id', req.params.topicId)
      .eq('client_id', req.params.clientId)
      .select()
      .single()
    if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message })
    res.json(data)
  }),
)

// AI idea suggestions from a topic. Loads the topic + its client for context,
// asks the model for 2-3 ideas, and returns them (does NOT save - the user picks one
// in the review modal, which then creates an idea and marks the topic done).
app.post(
  '/api/clients/:clientId/research-topics/:topicId/suggest',
  h(async (req, res) => {
    const { data: topic, error: tErr } = await supabase
      .from('research_topics')
      .select('*')
      .eq('id', req.params.topicId)
      .eq('client_id', req.params.clientId)
      .single()
    if (tErr) return res.status(tErr.code === 'PGRST116' ? 404 : 500).json({ error: tErr.message })

    const { data: client } = await supabase
      .from('clients')
      .select('name, tagline, industry, social_media_accounts, ref_documents')
      .eq('id', req.params.clientId)
      .single()

    try {
      const ideas = await suggestIdeasForTopic(topic.title, client || {})
      if (!ideas.length) return res.status(502).json({ error: 'The model returned no usable ideas. Try again.' })
      res.json({ ideas })
    } catch (e) {
      res.status(502).json({ error: e.message || 'Could not generate ideas' })
    }
  }),
)

// create a research topic under a client (the Manual tab's "Add" posts here)
app.post(
  '/api/clients/:clientId/research-topics',
  h(async (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
    if (!title) return res.status(400).json({ error: 'title is required' })
    const source = typeof req.body?.source === 'string' ? req.body.source : 'manual'
    const { data, error } = await supabase
      .from('research_topics')
      .insert({ title, client_id: req.params.clientId, source })
      .select()
      .single()
    // 23503 = foreign_key_violation -> the client_id doesn't exist
    if (error) return res.status(error.code === '23503' ? 404 : 500)
      .json({ error: error.code === '23503' ? 'client not found' : error.message })
    res.status(201).json(data)
  }),
)

// generate stream topics for a client
app.post(
  '/api/clients/:clientId/stream/generate',
  h(async (req, res) => {
    const result = await refreshStreamForClient(req.params.clientId)
    if (!result.ok) {
      return res.status(result.status || 500).json({ error: result.error || 'failed' })
    }
    // UI expects a non-empty list when the news fetch fails entirely.
    if (!result.added && !result.fetched) {
      return res.status(502).json({ error: 'Could not fetch stream topics from the news. Try again.' })
    }
    res.status(result.added ? 201 : 200).json(result.topics)
  }),
)

// delete a research topic (scoped to its client so ids can't cross boundaries)
app.delete(
  '/api/clients/:clientId/research-topics/:topicId',
  h(async (req, res) => {
    const { error } = await supabase
      .from('research_topics')
      .delete()
      .eq('id', req.params.topicId)
      .eq('client_id', req.params.clientId)
    if (error) return res.status(500).json({ error: error.message })
    res.status(204).end()
  }),
)

// --- Posts (Create-wizard sessions: drafts + finalized, scoped to a client) --
// ONE ROW PER PLATFORM. The rows produced by a single Create session share a
// batch_id, so a multi-platform post stays grouped while each channel carries its
// own title, content, note, format, tags, images and schedule date. status
// 'draft' = in progress (autosaved), 'scheduled'/'published' = finalized.

// Whitelist + coerce the per-platform columns a batch write may set.
const toPostRow = (r = {}) => ({
  platform: str(r.platform),
  title: typeof r.title === 'string' ? r.title.trim() : '',
  content: typeof r.content === 'string' ? r.content : '',
  note: typeof r.note === 'string' ? r.note : '',
  format: typeof r.format === 'string' ? r.format : '',
  tags: strArray(r.tags),
  image_paths: strArray(r.image_paths),
  image_prompt: typeof r.image_prompt === 'string' ? r.image_prompt : '',
  scheduled_at: str(r.scheduled_at) || null,
})

// list a client's posts (rows), most-recently-worked first. ?status=draft|scheduled|all
// (default all). Drafts head the list, so a plain refresh resumes the first batch.
app.get(
  '/api/clients/:clientId/posts',
  h(async (req, res) => {
    const status = req.query.status || 'all'
    let q = supabase
      .from('posts')
      .select('*')
      .eq('client_id', req.params.clientId)
      .order('updated_at', { ascending: false })
    if (status !== 'all') q = q.eq('status', status)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  }),
)

// Write a whole Create session (batch) at once: delete the batch's existing rows,
// then insert the current per-platform rows. Used for BOTH autosave (status
// 'draft') and finalize (status 'scheduled'). Body: { rows: [...], status? }.
app.put(
  '/api/clients/:clientId/posts/batch/:batchId',
  h(async (req, res) => {
    const status = POST_STATUSES.includes(req.body?.status) ? req.body.status : 'draft'
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : []
    // Replace the batch: clear its current rows, then insert the new set. Row ids
    // aren't stable across saves, which is fine — the batch_id is the identity.
    const { error: delErr } = await supabase
      .from('posts')
      .delete()
      .eq('client_id', req.params.clientId)
      .eq('batch_id', req.params.batchId)
    if (delErr) return res.status(500).json({ error: delErr.message })
    if (!rows.length) return res.json([])
    const toInsert = rows.map((r) => ({
      ...toPostRow(r),
      client_id: req.params.clientId,
      batch_id: req.params.batchId,
      status,
    }))
    const { data, error } = await supabase.from('posts').insert(toInsert).select('*')
    // 23503 = foreign_key_violation -> the client_id doesn't exist
    if (error) return res.status(error.code === '23503' ? 404 : 500)
      .json({ error: error.code === '23503' ? 'client not found' : error.message })
    res.json(data)
  }),
)

// delete an entire batch (discard a draft session), scoped to its client
app.delete(
  '/api/clients/:clientId/posts/batch/:batchId',
  h(async (req, res) => {
    const { error } = await supabase
      .from('posts')
      .delete()
      .eq('client_id', req.params.clientId)
      .eq('batch_id', req.params.batchId)
    if (error) return res.status(500).json({ error: error.message })
    res.status(204).end()
  }),
)

// update a single post row (the Posts-tab edit modal). Whitelists the editable
// columns; only the ones present in the body are written. Scoped to the client.
app.patch(
  '/api/clients/:clientId/posts/:postId',
  h(async (req, res) => {
    const b = req.body || {}
    const patch = {}
    if ('title' in b) patch.title = typeof b.title === 'string' ? b.title.trim() : ''
    if ('content' in b) patch.content = typeof b.content === 'string' ? b.content : ''
    if ('note' in b) patch.note = typeof b.note === 'string' ? b.note : ''
    if ('format' in b) patch.format = typeof b.format === 'string' ? b.format : ''
    if ('platform' in b && str(b.platform)) patch.platform = str(b.platform)
    if ('tags' in b) patch.tags = strArray(b.tags)
    if ('image_paths' in b) patch.image_paths = strArray(b.image_paths)
    if ('image_prompt' in b) patch.image_prompt = typeof b.image_prompt === 'string' ? b.image_prompt : ''
    if ('scheduled_at' in b) patch.scheduled_at = str(b.scheduled_at) || null
    if ('status' in b) {
      if (!POST_STATUSES.includes(b.status)) return res.status(400).json({ error: `status must be one of ${POST_STATUSES.join(', ')}` })
      patch.status = b.status
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no editable fields provided' })

    const { data, error } = await supabase
      .from('posts')
      .update(patch)
      .eq('id', req.params.postId)
      .eq('client_id', req.params.clientId)
      .select()
      .single()
    if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message })
    res.json(data)
  }),
)

// delete a single post row by id (scoped to its client)
app.delete(
  '/api/clients/:clientId/posts/:postId',
  h(async (req, res) => {
    const { error } = await supabase
      .from('posts')
      .delete()
      .eq('id', req.params.postId)
      .eq('client_id', req.params.clientId)
    if (error) return res.status(500).json({ error: error.message })
    res.status(204).end()
  }),
)

// AI: generate on-brand post copy for the Create wizard. Grounds the draft in
// the client's brand context (tone/voice/keywords) + any selected brand
// documents. Body: { topic, note, platform, format, documentNames: [...] }.
app.post(
  '/api/clients/:clientId/generate-content',
  h(async (req, res) => {
    const topic = str(req.body?.topic)
    const platform = str(req.body?.platform)
    if (!topic) return res.status(400).json({ error: 'topic is required' })
    if (!platform) return res.status(400).json({ error: 'platform is required' })

    const { data: client, error } = await supabase
      .from('clients')
      .select('id, name, tagline, industry, ref_documents, documents')
      .eq('id', req.params.clientId)
      .single()
    if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message })

    const allDocs = Array.isArray(client.documents) ? client.documents : []
    const names = Array.isArray(req.body?.documentNames) ? req.body.documentNames : []
    const docs = names.length ? allDocs.filter((d) => names.includes(d.name)) : []

    // Editorial learnings feed the Claude engine's CLAUDE.md. Guarded: if the
    // client_learnings migration hasn't been applied yet, generate without them.
    let learnings = []
    try {
      const { data } = await supabase
        .from('client_learnings')
        .select('content')
        .eq('client_id', req.params.clientId)
        .order('created_at', { ascending: false })
        .limit(30)
      learnings = data || []
    } catch { /* table may not exist yet */ }

    try {
      const polishRaw = req.body?.polish
      const polish =
        polishRaw === true || polishRaw === 'true' ? true
          : polishRaw === false || polishRaw === 'false' ? false
            : undefined
      const out = await generatePostContent({
        topic,
        note: str(req.body?.note),
        platform,
        format: str(req.body?.format),
        docs,
        client,
        learnings,
        pillar: str(req.body?.pillar),
        angle: str(req.body?.angle),
        polish,
      })
      const price = typeof out.costUsd === 'number' ? `$${out.costUsd.toFixed(4)}` : 'unknown'
      const files = Array.isArray(out.filesRead) && out.filesRead.length
        ? ` · ${out.filesRead.length} doc(s)`
        : ''
      console.log(`[content] ${client.name || client.id} · ${platform}/${str(req.body?.format) || '—'} · ${out.model || '?'} (${out.mode || out.engine || '?'}) · cost ${price}${files}`)
      res.json(out)
    } catch (e) {
      res.status(502).json({ error: e.message || 'Could not generate content' })
    }
  }),
)

// AI: generate on-brand post copy FROM AN IMAGE. The image is already stored in
// the client's Photo Library (so `imageUrl` is a public Storage URL); we fetch
// its bytes, hand them to a vision model with the idea/topic + brand context, and
// return the drafted copy. Body: { topic, note, platform, format, imageUrl }.
app.post(
  '/api/clients/:clientId/generate-content-image',
  h(async (req, res) => {
    const topic = str(req.body?.topic)
    const platform = str(req.body?.platform)
    const imageUrl = str(req.body?.imageUrl)
    if (!topic) return res.status(400).json({ error: 'topic is required' })
    if (!platform) return res.status(400).json({ error: 'platform is required' })
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required' })

    const { data: client, error } = await supabase
      .from('clients')
      .select('id, name, tagline, industry, ref_documents, documents')
      .eq('id', req.params.clientId)
      .single()
    if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message })

    // Ground the vision model in the client's writing-relevant brand documents —
    // the same tier the text engine inlines (core files + skill playbooks). If the
    // caller named specific docs, honour those; otherwise auto-select. Bounded by
    // buildDocsContext (per-doc + total caps) so the prompt stays sane.
    const allDocs = Array.isArray(client.documents) ? client.documents : []
    const names = Array.isArray(req.body?.documentNames) ? req.body.documentNames : []
    const docs = names.length
      ? allDocs.filter((d) => names.includes(d.name))
      : allDocs.filter((d) => /core|skill/i.test(String(d?.tag || ''))).slice(0, 8)

    // Editorial learnings (guarded — the table may not exist on older DBs).
    let learnings = []
    try {
      const { data } = await supabase
        .from('client_learnings')
        .select('content')
        .eq('client_id', req.params.clientId)
        .order('created_at', { ascending: false })
        .limit(30)
      learnings = data || []
    } catch { /* table may not exist yet */ }

    // Fetch the stored image → data-URL for the vision call. The photos bucket is
    // public, so a plain fetch works.
    let imageDataUrl
    try {
      const ir = await fetch(imageUrl)
      if (!ir.ok) throw new Error(`image fetch ${ir.status}`)
      const ct = (ir.headers.get('content-type') || 'image/jpeg').split(';')[0].trim()
      const buf = Buffer.from(await ir.arrayBuffer())
      if (!buf.length) throw new Error('empty image')
      if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'image is too large (max 8MB) for generation' })
      imageDataUrl = `data:${ct};base64,${buf.toString('base64')}`
    } catch {
      return res.status(400).json({ error: 'Could not load the image for generation' })
    }

    try {
      const out = await generatePostContentFromImage({
        topic, note: str(req.body?.note), platform, format: str(req.body?.format), imageDataUrl, docs, client, learnings,
      })
      if (!out.body || !out.body.trim()) return res.status(502).json({ error: 'The model returned no content from the image' })
      const price = typeof out.costUsd === 'number' ? `$${out.costUsd.toFixed(4)}` : 'unknown'
      console.log(`[content] ${client.name || client.id} · ${platform}/${str(req.body?.format) || '—'} · from-image · ${out.model || '?'} · cost ${price}`)
      res.json(out)
    } catch (e) {
      res.status(502).json({ error: e.message || 'Could not generate content from the image' })
    }
  }),
)

// --- Client learnings (the brand brain's memory tier) -----------------------
// Small editorial facts per client (corrections, preferences, wins). The
// generate-content route injects the latest ones into the Claude engine's
// CLAUDE.md so every generation applies past feedback.

const LEARNING_KINDS = ['note', 'correction', 'preference', 'win']

// list a client's learnings (newest first)
app.get(
  '/api/clients/:clientId/learnings',
  h(async (req, res) => {
    const { data, error } = await supabase
      .from('client_learnings')
      .select('*')
      .eq('client_id', req.params.clientId)
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  }),
)

// record a learning. Body: { content, kind?, source? }
app.post(
  '/api/clients/:clientId/learnings',
  h(async (req, res) => {
    const content = str(req.body?.content)
    if (!content) return res.status(400).json({ error: 'content is required' })
    const row = {
      client_id: req.params.clientId,
      content,
      kind: LEARNING_KINDS.includes(req.body?.kind) ? req.body.kind : 'note',
      source: ['manual', 'edit', 'rejection'].includes(req.body?.source) ? req.body.source : 'manual',
    }
    const { data, error } = await supabase.from('client_learnings').insert(row).select().single()
    if (error) return res.status(error.code === '23503' ? 404 : 500)
      .json({ error: error.code === '23503' ? 'client not found' : error.message })
    res.status(201).json(data)
  }),
)

// delete a learning (scoped to its client)
app.delete(
  '/api/clients/:clientId/learnings/:learningId',
  h(async (req, res) => {
    const { error } = await supabase
      .from('client_learnings')
      .delete()
      .eq('id', req.params.learningId)
      .eq('client_id', req.params.clientId)
    if (error) return res.status(500).json({ error: error.message })
    res.status(204).end()
  }),
)

// --- Photo Library (photos scoped to a client) -----------------------------

// list a client's photos (newest first)
app.get(
  '/api/clients/:clientId/photos',
  h(async (req, res) => {
    const { data, error } = await supabase
      .from('photos')
      .select('*')
      .eq('client_id', req.params.clientId)
      .order('position', { ascending: true })
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  }),
)

// reorder a client's photos: body { ids: [...] } sets each row's `position` to
// its index in the array. Scoped to the client so ids can't cross boundaries.
app.patch(
  '/api/clients/:clientId/photos/order',
  h(async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((x) => typeof x === 'string') : []
    if (!ids.length) return res.status(400).json({ error: 'ids (array) is required' })
    const results = await Promise.all(
      ids.map((id, i) =>
        supabase.from('photos').update({ position: i }).eq('id', id).eq('client_id', req.params.clientId),
      ),
    )
    const failed = results.find((r) => r.error)
    if (failed) return res.status(500).json({ error: failed.error.message })
    res.status(204).end()
  }),
)

// upload a photo (multipart image) → Storage (foldered per client) → insert the
// metadata row. Returns the saved row.
app.post(
  '/api/clients/:clientId/photos',
  upload.single('file'),
  h(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file is required' })
    if (!isAllowedPhoto(req.file))
      return res.status(400).json({ error: `Only ${PHOTO_TYPES_LABEL} images are allowed` })

    await ensureBucket(PHOTOS_BUCKET)
    const clientId = req.params.clientId
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')
    const path = `${clientId}/${Date.now()}-${safeName}`
    const { error: upErr } = await supabase.storage
      .from(PHOTOS_BUCKET)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false })
    if (upErr) return res.status(500).json({ error: upErr.message })

    const { data: pub } = supabase.storage.from(PHOTOS_BUCKET).getPublicUrl(path)
    const title =
      typeof req.body.title === 'string' && req.body.title.trim()
        ? req.body.title.trim()
        : req.file.originalname.replace(/\.[^.]+$/, '')

    const { data, error } = await supabase
      .from('photos')
      .insert({
        client_id: clientId,
        title,
        url: pub.publicUrl,
        storage_path: path,
        mime: req.file.mimetype,
        size_bytes: req.file.size,
      })
      .select()
      .single()
    if (error) {
      // the row failed to insert - don't orphan the just-uploaded file
      await supabase.storage.from(PHOTOS_BUCKET).remove([path])
      // 23503 = foreign_key_violation → the client_id doesn't exist
      return res
        .status(error.code === '23503' ? 404 : 500)
        .json({ error: error.code === '23503' ? 'client not found' : error.message })
    }
    res.status(201).json(data)
  }),
)

// delete a photo (metadata row + the stored file), scoped to its client so ids
// can't cross client boundaries.
app.delete(
  '/api/clients/:clientId/photos/:photoId',
  h(async (req, res) => {
    // read the row first so we know which storage object to remove
    const { data: row, error: selErr } = await supabase
      .from('photos')
      .select('storage_path')
      .eq('id', req.params.photoId)
      .eq('client_id', req.params.clientId)
      .single()
    if (selErr) return res.status(selErr.code === 'PGRST116' ? 404 : 500).json({ error: selErr.message })

    const { error } = await supabase
      .from('photos')
      .delete()
      .eq('id', req.params.photoId)
      .eq('client_id', req.params.clientId)
    if (error) return res.status(500).json({ error: error.message })

    // best-effort file cleanup (the row is already gone either way)
    if (row?.storage_path) await supabase.storage.from(PHOTOS_BUCKET).remove([row.storage_path])
    res.status(204).end()
  }),
)

// --- AI Image Generation (scoped to a client) ------------------------------

// Generate on-brand image(s) from a prompt + guardrail controls. Reference
// images (library URLs or uploaded data-URLs) condition the result. This is
// transient: nothing is stored - the client saves the ones it likes via /save.
// Body: { prompt, style, lighting, aspect, brandColors[], avoid, references[], count }
// Returns { images: ["data:image/...", ...], prompt, model }.
app.post(
  '/api/clients/:clientId/images/generate',
  h(async (req, res) => {
    const b = req.body || {}
    if (typeof b.prompt !== 'string' || !b.prompt.trim())
      return res.status(400).json({ error: 'a prompt is required' })

    // Ground every generation in the client's markdown brand/design docs, read
    // from the DB (authoritative) rather than trusting client-sent content. If the
    // caller named specific docs, honour those; otherwise auto-select the core/skill
    // .md files — the same tier the text engine inlines — so the image follows the
    // brand's visual guidance without the user having to pick documents by hand.
    let documents = []
    let logoUrl = ''
    {
      const { data: row } = await supabase
        .from('clients')
        .select('documents, ref_documents')
        .eq('id', req.params.clientId)
        .single()
      const all = Array.isArray(row?.documents) ? row.documents : []
      const wanted = Array.isArray(b.docNames) ? b.docNames.filter((x) => typeof x === 'string') : []
      documents = wanted.length
        ? all.filter((d) => d && wanted.includes(d.name))
        : all.filter((d) => {
            if (!d) return false
            const tag = String(d.tag || '')
            const name = String(d.name || '')
            // Visual guidance lives in core (+ writing skills). Skip architecture
            // / project-plan dumps often dropped into skills — they aren't image cues.
            if (!/core|skill/i.test(tag)) return false
            // Skip architecture / project-plan dumps (underscored names too —
            // \b fails on CogniProcure_Project_Plan_Mermaid).
            if (/skill/i.test(tag) && /project[-_]?plan|architecture|mermaid|roadmap|system[-_]?arch/i.test(name)) return false
            return true
          }).slice(0, 8)

      // Resolve the client's effective logo (manual overrides scraped) so an
      // enabled "Add logo" toggle composites the real mark from Storage.
      if (b.logo === true) {
        const rd = row?.ref_documents && typeof row.ref_documents === 'object' ? row.ref_documents : {}
        logoUrl = rd.logo_url || rd.logo_manual || rd.logo_scraped || ''
      }
    }

    try {
      const out = await generateImages({
        prompt: b.prompt,
        style: b.style,
        composition: b.composition,
        lighting: b.lighting,
        aspect: b.aspect,
        brandColors: b.brandColors,
        documents,
        avoid: b.avoid,
        logo: b.logo,
        logoUrl,
        references: b.references,
        count: b.count,
      })
      const mods = out.modules || {}
      const modSummary = [
        `style=${mods.style || b.style || 'auto'}`,
        `composition=${mods.composition || b.composition || 'auto'}`,
        `lighting=${mods.lighting || b.lighting || 'auto'}`,  
        `aspect=${mods.aspect || b.aspect || 'square'}`,
        `refs=${mods.references ?? (Array.isArray(b.references) ? b.references.length : 0)}`,
        `logo=${mods.logo === true ? 'on' : 'off'}`,
        `palette=${Array.isArray(mods.brandColors) ? mods.brandColors.length : (Array.isArray(b.brandColors) ? b.brandColors.length : 0)}`,
        `docs=${Array.isArray(mods.documents) && mods.documents.length ? mods.documents.join('|') : (documents.map((d) => d.name).filter(Boolean).join('|') || 'none')}`,
      ].join(' · ')
      console.log(
        `[images] ${req.params.clientId} · ${out.model || '?'} · ${out.images?.length || 0} image(s) · billed ${typeof out.costUsd === 'number' ? `$${out.costUsd.toFixed(4)}` : 'unknown'}${out.costSource ? ` (${out.costSource})` : ''} · ${modSummary}`,
      )
      res.json(out)
    } catch (e) {
      res.status(502).json({ error: e.message || 'Image generation failed' })
    }
  }),
)

// Save a generated image (a base64 data-URL) into the client's Photo Library,
// so it lands in the same gallery as uploads and is ready to attach to a post.
// Body: { dataUrl, title, prompt }. Returns the saved photo row.
app.post(
  '/api/clients/:clientId/images/save',
  h(async (req, res) => {
    const decoded = decodeDataUrl(req.body?.dataUrl)
    if (!decoded) return res.status(400).json({ error: 'a valid image dataUrl is required' })

    await ensureBucket(PHOTOS_BUCKET)
    const clientId = req.params.clientId
    const path = `${clientId}/ai-${Date.now()}-${randomSlug()}.${decoded.ext}`
    const { error: upErr } = await supabase.storage
      .from(PHOTOS_BUCKET)
      .upload(path, decoded.buffer, { contentType: decoded.mime, upsert: false })
    if (upErr) return res.status(500).json({ error: upErr.message })

    const { data: pub } = supabase.storage.from(PHOTOS_BUCKET).getPublicUrl(path)
    const title =
      typeof req.body.title === 'string' && req.body.title.trim()
        ? req.body.title.trim().slice(0, 120)
        : 'AI generated image'

    const { data, error } = await supabase
      .from('photos')
      .insert({
        client_id: clientId,
        title,
        url: pub.publicUrl,
        storage_path: path,
        mime: decoded.mime,
        size_bytes: decoded.buffer.length,
      })
      .select()
      .single()
    if (error) {
      await supabase.storage.from(PHOTOS_BUCKET).remove([path])
      return res
        .status(error.code === '23503' ? 404 : 500)
        .json({ error: error.code === '23503' ? 'client not found' : error.message })
    }
    res.status(201).json(data)
  }),
)

// --- social performance (live data via Apify) ------------------------------
// The client's configured handles live on clients.social_media_accounts; these
// routes scrape those handles through Apify and cache the result server-side.
// Scraping is never done on read — a page load always serves cache, and only
// an explicit POST /refresh spends Apify credits.

// Which of a client's configured channels we can actually scrape.
async function connectedChannels(clientId) {
  const { data, error } = await supabase
    .from('clients')
    .select('social_media_accounts')
    .eq('id', clientId)
    .single()
  if (error) throw new Error(error.message)

  const list = Array.isArray(data?.social_media_accounts) ? data.social_media_accounts : []
  const kept = []
  for (const s of list) {
    const platform = String(s?.platform || '').toLowerCase()
    // Handle first on every platform, including Substack: the url field is
    // often left as a bare platform root ("https://substack.com/"), which
    // resolves to the homepage and scrapes nothing. bareHandle understands
    // both shapes, so there is no reason to special-case the source here.
    const raw = s?.handle || s?.url
    const handle = bareHandle(raw, platform)
    if (!platform) {
      log.warn('[social] skip account: missing platform', { handle: s?.handle, url: s?.url })
      continue
    }
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      log.warn('[social] skip account: unsupported platform', { platform, handle: s?.handle, url: s?.url })
      continue
    }
    if (!handle) {
      log.warn('[social] skip account: empty/invalid handle', { platform, handle: s?.handle, url: s?.url })
      continue
    }
    kept.push({ platform, handle })
  }
  return kept
}

// GET  /api/clients/:clientId/social — cached metrics, posts and history.
app.get(
  '/api/clients/:clientId/social',
  h(async (req, res) => {
    const [channels, latest, history] = await Promise.all([
      connectedChannels(req.params.clientId),
      getLatest(req.params.clientId),
      getHistory(req.params.clientId),
    ])
    res.json({
      supportedPlatforms: SUPPORTED_PLATFORMS,
      configured: channels,
      channels: latest,
      history,
      // Null until the first successful refresh in this server lifetime.
      lastSyncedAt: Object.values(latest).reduce(
        (a, c) => (c?.fetchedAt && (!a || c.fetchedAt > a) ? c.fetchedAt : a), null,
      ),
    })
  }),
)

// POST /api/clients/:clientId/social/refresh — scrape now, then cache.
// Body: { platform?: 'instagram' } to refresh one channel instead of all.
app.post(
  '/api/clients/:clientId/social/refresh',
  h(async (req, res) => {
    const clientId = req.params.clientId
    const only = String(req.body?.platform || '').toLowerCase()
    log.info('[social] refresh start', { clientId, only: only || 'all' })
    let channels = await connectedChannels(clientId)
    log.info('[social] scrapeable channels', channels)
    if (only) channels = channels.filter((c) => c.platform === only)

    if (!channels.length) {
      log.error('[social] refresh aborted: no scrapeable channels', { clientId, only: only || 'all' })
      return res.status(400).json({
        error: only
          ? `No handle configured for ${only}. Add it under Profile → Channels.`
          : 'No scrapeable channels configured. Add an Instagram, LinkedIn, X, Substack or TikTok handle under Profile → Channels.',
      })
    }

    // One channel failing must not sink the others — report per-channel status.
    const settled = await Promise.all(channels.map(async ({ platform, handle }) => {
      log.info(`[social:${platform}] scrape start @${handle}`)
      try {
        const payload = await fetchPlatform(platform, handle)
        // saveSnapshot mirrors the images into Supabase Storage on the way in,
        // while the CDN links are still valid, and writes posts + the history
        // point. It returns the channel patch rather than writing it — see below.
        const patch = await saveSnapshot(clientId, platform, payload)
        const result = { platform, ok: true, followers: payload.account?.followers ?? null, posts: payload.posts.length }
        log.info(`[social:${platform}] scrape ok`, result)
        return { patch, result }
      } catch (err) {
        const message = err?.message || 'Scrape failed'
        log.error(`[social:${platform}] scrape failed @${handle}`, message)
        return { patch: saveError(clientId, platform, message), result: { platform, ok: false, error: message } }
      }
    }))

    // Channel stats live in ONE jsonb column, so every write rewrites the whole
    // array. Writing per-channel inside the parallel block above would mean the
    // last channel to finish clobbers the others. Commit them together instead.
    await commitChannelStats(clientId, settled.map((s) => s.patch))

    const results = settled.map((s) => s.result)
    const anyOk = results.some((r) => r.ok)
    log.info('[social] refresh done', { clientId, ok: results.filter((r) => r.ok).map((r) => r.platform), failed: results.filter((r) => !r.ok) })
    const [latest, history] = await Promise.all([getLatest(clientId), getHistory(clientId)])

    res.status(anyOk ? 200 : 502).json({
      results,
      channels: latest,
      history,
      lastSyncedAt: new Date().toISOString(),
    })
  }),
)

// --- branding extractor (headless-browser engine + SSE progress) -----------
// POST /api/extract, GET /api/status/:jobId (SSE), GET /api/files/:jobId/*
app.use(extractionRouter)

// --- serve the built frontend (single-service deploy) ----------------------
// In production one service hosts everything: this server serves the React
// build (client/dist) AND the /api routes on the same origin - so no CORS and
// no VITE_API_URL needed. Skips silently in dev where client/dist won't exist.
const clientDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'dist')
app.use(express.static(clientDist))
// SPA fallback: any non-/api GET returns index.html (React Router takes over).
app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(clientDist, 'index.html')))

// error middleware
app.use((err, _req, res, _next) => {
  // Errors that already carry a status (express.static's 404 for a missing
  // mirrored image, for one) must keep it — reporting those as 500 would say
  // the server broke when the file simply isn't there.
  const status = Number(err?.status || err?.statusCode) || 500
  if (status >= 500) console.error('[server]', err)
  res.status(status).json({ error: err.message || 'Internal error' })
})

const httpServer = app.listen(PORT, () => {
  log.info(`[server] Content Engine API on http://localhost:${PORT}`)
  log.info(`[server] daily logs → ${LOG_DIR}`)
  log.info('[server] Apify comment scrapers', {
    commentsPerPost: COMMENTS_PER_POST,
    instagram: APIFY_ACTORS.instagram_comments,
    linkedin: APIFY_ACTORS.linkedin_comments,
    x: APIFY_ACTORS.x_comments,
    tiktok: APIFY_ACTORS.tiktok_comments,
  })
})
// Node 18+ defaults requestTimeout to 5 minutes. TikTok Apify runs poll for
// up to ~8 minutes, so a refresh would otherwise be killed mid-scrape and
// the channel would look like it never fetched.
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 600000)
httpServer.timeout = HTTP_TIMEOUT_MS
httpServer.headersTimeout = HTTP_TIMEOUT_MS + 5000
httpServer.requestTimeout = HTTP_TIMEOUT_MS
