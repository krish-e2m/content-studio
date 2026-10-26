// =========================================================================
// API client. Talks to the Node/Express server (Supabase-backed).
// In dev, Vite proxies /api → http://localhost:4000 (see vite.config.js).
// Override the base with VITE_API_URL for other environments.
// =========================================================================

import { normalizeUrl } from './lib/util.js'

const BASE = import.meta.env.VITE_API_URL || ''

// --- session token ----------------------------------------------------------
// Access + refresh tokens live in localStorage so a reload restores the
// session. Access JWTs expire (~1h); on 401 we silently refresh and retry so
// the user stays signed in until they explicitly sign out.
const TOKEN_KEY = 'studio.token'
const REFRESH_KEY = 'studio.refresh'
let token = localStorage.getItem(TOKEN_KEY) || ''

export const getToken = () => token
// For the multipart uploads below, which bypass req() because the browser must
// set its own Content-Type boundary — they still need the bearer token.
export const authHeaders = () => (token ? { Authorization: `Bearer ${token}` } : {})

export function setToken(next) {
  token = next || ''
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY) || ''
}

function setRefreshToken(next) {
  const v = next || ''
  if (v) localStorage.setItem(REFRESH_KEY, v)
  else localStorage.removeItem(REFRESH_KEY)
}

function setSession({ token: access, refreshToken } = {}) {
  setToken(access || '')
  // Only overwrite the refresh token when the server sent a new one (rotation).
  if (refreshToken !== undefined) setRefreshToken(refreshToken)
}

function clearSession() {
  setToken('')
  setRefreshToken('')
}

// Notified when the server rejects our token, so the app can bounce to /login
// instead of rendering a page full of failed requests.
let onUnauthorized = () => {}
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn || (() => {}) }

// Single-flight refresh: concurrent 401s share one refresh call.
let refreshInFlight = null

async function refreshSession() {
  const rt = getRefreshToken()
  if (!rt) return false
  try {
    const res = await fetch(`${BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.token) return false
    setSession({ token: body.token, refreshToken: body.refreshToken })
    return true
  } catch {
    return false
  }
}

function ensureFreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = refreshSession().finally(() => { refreshInFlight = null })
  }
  return refreshInFlight
}

async function req(path, opts = {}, didRetry = false) {
  let res
  try {
    res = await fetch(`${BASE}/api${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.headers || {}),
      },
    })
  } catch {
    throw new Error('Cannot reach the API. Is the server running on :4000?')
  }
  // A 401 from login/refresh is a real auth failure — don't try to refresh again.
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/refresh') {
    if (!didRetry && getRefreshToken()) {
      const ok = await ensureFreshSession()
      if (ok) return req(path, opts, true)
    }
    clearSession()
    onUnauthorized()
    throw new Error('Your session expired. Please sign in again.')
  }
  if (res.status === 204) return null
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`)
  return body
}

// Shared 401 handling for multipart uploads that don't go through req().
// Retries at most once after a successful refresh.
async function handleAuthFailure(res, retry, didRetry = false) {
  if (res.status !== 401) return null
  if (!didRetry && getRefreshToken()) {
    const ok = await ensureFreshSession()
    if (ok && retry) return retry()
  }
  clearSession()
  onUnauthorized()
  throw new Error('Your session expired. Please sign in again.')
}

// --- auth -------------------------------------------------------------------
export async function login(email, password) {
  const out = await req('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  setSession({ token: out.token, refreshToken: out.refreshToken })
  return out.user
}
export const fetchMe = () => req('/auth/me').then((r) => r.user)
export const logout = () => clearSession()

// --- users (admin only) -----------------------------------------------------
export const listUsers = () => req('/users')
export const createUser = (payload) => req('/users', { method: 'POST', body: JSON.stringify(payload) })
export const setUserClients = (userId, clientIds) =>
  req(`/users/${userId}/clients`, { method: 'PUT', body: JSON.stringify({ clientIds }) })
export const deleteUser = (userId) => req(`/users/${userId}`, { method: 'DELETE' })

// AI spend per client, for the Users & access table. `days` narrows the window;
// omit it for all time. Returns { ready, byClient, total, credits, … } - see
// /api/usage/spend.
export const usageSpend = (days) => req(`/usage/spend${days ? `?days=${days}` : ''}`)

export const listClients = () => req('/clients')
export const getClient = (id) => req(`/clients/${id}`)
export const createClient = (row) => req('/clients', { method: 'POST', body: JSON.stringify(row) })
export const updateClient = (id, patch) => req(`/clients/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
export const deleteClient = (id) => req(`/clients/${id}`, { method: 'DELETE' })

// Draft starter core/*.md brand documents from the structured brand guideline
// (server-side templating, no AI). Existing docs are never overwritten.
// Returns { client, added }.
export const draftBrandFiles = (id) => req(`/clients/${id}/brand-files/draft`, { method: 'POST' })

// --- Social performance (live data via Apify) -------------------------------
// getSocial() only ever reads the server-side cache, so it's cheap and safe to
// call on every page load. refreshSocial() is what actually spends Apify
// credits, so it's only wired to an explicit user action.
export const getSocial = (clientId) => req(`/clients/${clientId}/social`)

// Scraped post thumbnails and avatars are mirrored server-side at scrape time
// (the platform CDN links expire), and come back as an origin-less
// /api/media/... path. When the API lives on a different origin, that path has
// to be resolved against the API — not the page — or the <img> 404s.
export const mediaSrc = (url) =>
  (typeof url === 'string' && url.startsWith('/api/') ? `${BASE}${url}` : url)

export const refreshSocial = (clientId, platform) =>
  req(`/clients/${clientId}/social/refresh`, {
    method: 'POST',
    body: JSON.stringify(platform ? { platform } : {}),
  })

// Append a line to the server's daily log file (logs/YYYY-MM-DD.log).
// Fire-and-forget — a logging failure must never break the UI.
export const logClient = (level, message, extra) => {
  req('/logs', {
    method: 'POST',
    body: JSON.stringify({ level, message, extra, source: 'client' }),
  }).catch(() => {})
}

// --- Idea Bank --------------------------------------------------------------
// The DB stores snake_case columns (description, draft_link, created_at); the
// workspace UI uses note/draftLink/createdAt. These adapters map between them so
// the rest of the app keeps its existing idea shape.
const fromIdeaRow = (r) => ({
  id: r.id,
  title: r.title,
  note: r.description || '',
  audience: r.audience || '',
  priority: r.priority || '',
  draftLink: r.draft_link || '',
  tags: r.tags || [],
  platforms: r.platforms || ['linkedin'],
  // Persisted content type (per channel) + reference images, so the Idea Bank
  // "Create" button can generate without re-asking. Absent on pre-migration rows.
  contentType: r.content_type || {},
  refImages: Array.isArray(r.ref_images) ? r.ref_images : [],
  createdAt: r.created_at,
})
const toIdeaRow = (idea) => ({
  title: idea.title,
  description: idea.note || '',
  audience: idea.audience || '',
  priority: idea.priority || null, // '' -> null so it passes the DB CHECK
  tags: idea.tags || [],
  draft_link: idea.draftLink ? normalizeUrl(idea.draftLink) : null,
  platforms: idea.platforms?.length ? idea.platforms : ['linkedin'],
  content_type: idea.contentType && typeof idea.contentType === 'object' ? idea.contentType : {},
  ref_images: Array.isArray(idea.refImages) ? idea.refImages : [],
})

export const listIdeas = (clientId) => req(`/clients/${clientId}/ideas`).then((rows) => rows.map(fromIdeaRow))
export const createIdea = (clientId, idea) =>
  req(`/clients/${clientId}/ideas`, { method: 'POST', body: JSON.stringify(toIdeaRow(idea)) }).then(fromIdeaRow)
export const updateIdea = (clientId, ideaId, idea) =>
  req(`/clients/${clientId}/ideas/${ideaId}`, { method: 'PATCH', body: JSON.stringify(toIdeaRow(idea)) }).then(fromIdeaRow)
export const deleteIdea = (clientId, ideaId) => req(`/clients/${clientId}/ideas/${ideaId}`, { method: 'DELETE' })

// --- Research topics --------------------------------------------------------
// The Manual tab of the Research page. The DB stores { id, title, created_at };
// the UI works in { id, text, createdAt }, so map between them here.
const fromTopicRow = (r) => ({ id: r.id, text: r.title, status: r.status || 'open', source: r.source || 'manual', createdAt: r.created_at })

// Load ALL topics (open + done) — done ones stay visible in the list.
export const listResearchTopics = (clientId, source = 'manual') =>
  req(`/clients/${clientId}/research-topics?status=all&source=${source}`).then((rows) => rows.map(fromTopicRow))
export const createResearchTopic = (clientId, text, source = 'manual') =>
  req(`/clients/${clientId}/research-topics`, { method: 'POST', body: JSON.stringify({ title: text, source }) }).then(fromTopicRow)
export const deleteResearchTopic = (clientId, topicId) =>
  req(`/clients/${clientId}/research-topics/${topicId}`, { method: 'DELETE' })
// mark a topic done (or reopen it): patch { status }
export const updateResearchTopic = (clientId, topicId, patch) =>
  req(`/clients/${clientId}/research-topics/${topicId}`, { method: 'PATCH', body: JSON.stringify(patch) }).then(fromTopicRow)
// AI: get 2-3 suggested ideas for a topic → { ideas: [{ title, description, tags, platform }] }
export const suggestResearchIdeas = (clientId, topicId) =>
  req(`/clients/${clientId}/research-topics/${topicId}/suggest`, { method: 'POST' }).then((r) => r.ideas || [])

// Generate live trending news stream topics and save them.
export const generateStreamTopics = (clientId) =>
  req(`/clients/${clientId}/stream/generate`, { method: 'POST' }).then((rows) => rows.map(fromTopicRow))
// --- Posts (Create-wizard sessions: ONE ROW PER PLATFORM, grouped by batch_id) -
// A row = { id, batchId, platform, status, title, content, note, format, tags,
// imagePaths, imagePrompt, scheduledAt }. All the platform rows of one Create
// session share a batch_id; drafts are 'draft', finalized 'scheduled'.
const fromPostRow = (r) => ({
  id: r.id,
  batchId: r.batch_id || null,
  platform: r.platform || '',
  status: r.status,
  title: r.title || '',
  content: r.content || '',
  note: r.note || '',
  format: r.format || '',
  tags: r.tags || [],
  imagePaths: r.image_paths || [],
  imagePrompt: r.image_prompt || '',
  scheduledAt: r.scheduled_at || '',
  updatedAt: r.updated_at,
})
const toPostRow = (r) => ({
  platform: r.platform,
  title: r.title || '',
  content: r.content || '',
  note: r.note || '',
  format: r.format || '',
  tags: r.tags || [],
  image_paths: r.imagePaths || [],
  image_prompt: r.imagePrompt || '',
  scheduled_at: r.scheduledAt || null,
})

// list posts, optionally filtered by status ('draft' | 'scheduled' | 'published')
export const listPosts = (clientId, status) =>
  req(`/clients/${clientId}/posts${status ? `?status=${status}` : ''}`).then((rows) => rows.map(fromPostRow))
// the wizard's in-progress drafts (status='draft'), most-recently-worked first
export const listPostDrafts = (clientId) => listPosts(clientId, 'draft')
// write a whole batch (all platform rows) at once — autosave (status 'draft') and
// finalize (status 'scheduled') both go through here. Returns the saved rows.
export const savePostBatch = (clientId, batchId, rows, status) =>
  req(`/clients/${clientId}/posts/batch/${batchId}`, { method: 'PUT', body: JSON.stringify({ rows: rows.map(toPostRow), status }) }).then((out) => out.map(fromPostRow))
export const deletePostBatch = (clientId, batchId) => req(`/clients/${clientId}/posts/batch/${batchId}`, { method: 'DELETE' })
export const deletePost = (clientId, postId) => req(`/clients/${clientId}/posts/${postId}`, { method: 'DELETE' })
// update a single post row (Posts-tab edit). Maps UI fields → columns; only the
// keys present are sent, so the server patches just those.
export const updatePost = (clientId, postId, patch = {}) => {
  const body = {}
  if ('title' in patch) body.title = patch.title
  if ('content' in patch) body.content = patch.content
  if ('note' in patch) body.note = patch.note
  if ('format' in patch) body.format = patch.format
  if ('platform' in patch) body.platform = patch.platform
  if ('status' in patch) body.status = patch.status
  if ('tags' in patch) body.tags = patch.tags
  if ('scheduledAt' in patch) body.scheduled_at = patch.scheduledAt || null
  if ('imagePaths' in patch) body.image_paths = patch.imagePaths
  return req(`/clients/${clientId}/posts/${postId}`, { method: 'PATCH', body: JSON.stringify(body) }).then(fromPostRow)
}

// AI: generate on-brand post copy grounded in the client's brand voice + the
// selected brand documents. payload: { topic, note, platform, format, documentNames }
// → { body }
export const generatePostContent = (clientId, payload) =>
  req(`/clients/${clientId}/generate-content`, { method: 'POST', body: JSON.stringify(payload) })

// AI: generate on-brand post copy grounded in an uploaded image (already stored
// in the Photo Library, so `imageUrl` is its public Storage URL) + the idea's
// topic/note + the client's brand context. payload: { topic, note, platform,
// format, imageUrl } → { body }
export const generatePostContentFromImage = (clientId, payload) =>
  req(`/clients/${clientId}/generate-content-image`, { method: 'POST', body: JSON.stringify(payload) })

// --- Client learnings (brand-brain memory tier) ------------------------------
// Small editorial facts (corrections, preferences, wins) the AI writer applies
// on every generation. kind: note|correction|preference|win.
export const listLearnings = (clientId) => req(`/clients/${clientId}/learnings`)
export const addLearning = (clientId, { content, kind, source }) =>
  req(`/clients/${clientId}/learnings`, { method: 'POST', body: JSON.stringify({ content, kind, source }) })
export const deleteLearning = (clientId, learningId) =>
  req(`/clients/${clientId}/learnings/${learningId}`, { method: 'DELETE' })

// --- Photo Library ----------------------------------------------------------
// The DB stores snake_case columns (storage_path, size_bytes, created_at); the
// workspace UI uses path/size/createdAt. This adapter maps between them.
const fromPhotoRow = (r) => ({
  id: r.id,
  title: r.title || '',
  url: r.url,
  path: r.storage_path,
  mime: r.mime || '',
  size: r.size_bytes || 0,
  createdAt: r.created_at,
})

export const listPhotos = (clientId) =>
  req(`/clients/${clientId}/photos`).then((rows) => rows.map(fromPhotoRow))

// Upload one image (multipart) under a client. Optional title (defaults to the
// filename server-side). Returns the saved photo in the UI shape.
export async function uploadPhoto(clientId, file, title) {
  const fd = new FormData()
  fd.append('file', file)
  if (title) fd.append('title', title)
  const send = async (didRetry = false) => {
    let res
    try {
      res = await fetch(`${BASE}/api/clients/${clientId}/photos`, { method: 'POST', body: fd, headers: authHeaders() })
    } catch {
      throw new Error('Cannot reach the API. Is the server running on :4000?')
    }
    const retried = await handleAuthFailure(res, () => send(true), didRetry)
    if (retried) return retried
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `Upload failed (${res.status})`)
    return fromPhotoRow(body)
  }
  return send()
}

export const deletePhoto = (clientId, photoId) =>
  req(`/clients/${clientId}/photos/${photoId}`, { method: 'DELETE' })

// --- AI Image Generation ----------------------------------------------------
// Generate on-brand image(s) from a prompt + guardrail controls (style, mood,
// aspect, brand palette) and optional reference images. Transient - returns
// { images: [dataUrl, ...], prompt, model }; nothing is stored until saved.
// Takes ~5-20s per image, so callers should show a loading state.
export const generateImages = (clientId, params) =>
  req(`/clients/${clientId}/images/generate`, { method: 'POST', body: JSON.stringify(params) })

// Save a generated image (a base64 data-URL) into the client's Photo Library.
// Returns the saved photo in the UI shape (so it can be prepended to the list).
export const saveGeneratedImage = (clientId, { dataUrl, title, prompt }) =>
  req(`/clients/${clientId}/images/save`, {
    method: 'POST',
    body: JSON.stringify({ dataUrl, title, prompt }),
  }).then(fromPhotoRow)

// Persist a manual photo order: `ids` in the desired order → row.position = index.
export const reorderPhotos = (clientId, ids) =>
  req(`/clients/${clientId}/photos/order`, { method: 'PATCH', body: JSON.stringify({ ids }) })

// Fetch + store a website's logo (deletes prevUrl if the file changed).
// Returns { url, domain }.
export const fetchLogo = (url, prevUrl) =>
  req('/logo', { method: 'POST', body: JSON.stringify({ url, prevUrl }) })

// Crawl a website + extract a structured brand identity via Groq.
// Returns { data, meta }. (Can take 10-30s - crawl + LLM.)
export const extractBrand = (url) => req('/brand/extract', { method: 'POST', body: JSON.stringify({ url }) })

// Run the headless-browser brand extractor (the separate engine). POSTs the
// url, then streams progress over SSE. Calls onProgress(message) per step and
// resolves with { jobId, branding } (the parsed branding.json) on completion.
// Takes ~30-90s - it paints the real page and crawls a few more.
export async function extractBrandSiteLive(url, onProgress) {
  let res
  try {
    res = await fetch(`${BASE}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
  } catch {
    throw new Error('Cannot reach the API. Is the server running on :4000?')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`)
  const jobId = body.jobId

  const branding = await new Promise((resolve, reject) => {
    const es = new EventSource(`${BASE}/api/status/${jobId}`)
    let settled = false
    const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); es.close(); fn(arg) }
    // The server stops a stuck job itself; this only guards against the stream
    // going quiet, so the Brand Brain loader can never wait forever.
    const timer = setTimeout(() => finish(reject, new Error('The brand extractor took too long')), 4 * 60 * 1000)
    es.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.type === 'progress') onProgress?.(msg.message)
      else if (msg.type === 'complete') finish(resolve, msg.result)
      else if (msg.type === 'error') finish(reject, new Error(msg.error || 'Extraction failed'))
    }
    es.onerror = () => finish(reject, new Error('Lost connection to the extractor'))
  })
  return { jobId, branding }
}

// Fetch an extracted asset (served by /api/files/:jobId/*) as a File, so it can
// be re-uploaded into Supabase storage (e.g. the extracted logo).
export async function extractedFileToFile(jobId, relPath, name) {
  const res = await fetch(`${BASE}/api/files/${jobId}/${relPath}`)
  if (!res.ok) throw new Error('extracted file not found')
  const blob = await res.blob()
  return new File([blob], name || relPath.split('/').pop(), { type: blob.type || 'application/octet-stream' })
}

// Extract a structured brand identity from an uploaded brand-guide PDF. Returns { data, meta }.
export async function extractBrandPdf(file) {
  const fd = new FormData()
  fd.append('file', file)
  const send = async (didRetry = false) => {
    let res
    try {
      res = await fetch(`${BASE}/api/brand/extract-pdf`, { method: 'POST', body: fd, headers: authHeaders() })
    } catch {
      throw new Error('Cannot reach the API. Is the server running on :4000?')
    }
    const retried = await handleAuthFailure(res, () => send(true), didRetry)
    if (retried) return retried
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `Extraction failed (${res.status})`)
    return body
  }
  return send()
}

// Upload a manual logo image. Returns { url, path }.
export async function uploadLogo(file, folder) {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('folder', folder || '')
  const send = async (didRetry = false) => {
    let res
    try {
      res = await fetch(`${BASE}/api/logo/upload`, { method: 'POST', body: fd, headers: authHeaders() })
    } catch {
      throw new Error('Cannot reach the API. Is the server running on :4000?')
    }
    const retried = await handleAuthFailure(res, () => send(true), didRetry)
    if (retried) return retried
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `Upload failed (${res.status})`)
    return body
  }
  return send()
}

// Upload a reference document (multipart). Returns { title, path, url }.
export async function uploadDocument(file, slug) {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('slug', slug || '')
  const send = async (didRetry = false) => {
    let res
    try {
      res = await fetch(`${BASE}/api/uploads`, { method: 'POST', body: fd, headers: authHeaders() })
    } catch {
      throw new Error('Cannot reach the API. Is the server running on :4000?')
    }
    const retried = await handleAuthFailure(res, () => send(true), didRetry)
    if (retried) return retried
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `Upload failed (${res.status})`)
    return body
  }
  return send()
}
