// =============================================================================
// RBAC middleware.
//
// There are no app tables for this: role and client assignments live in
// auth.users.raw_user_meta_data (exposed by the SDK as `user_metadata`):
//
//   { "is_admin": true }                                   -> admin, every client
//   { "is_user": true, "client_ids": ["<uuid>", ...] }      -> restricted user
//   neither flag                                           -> NO ACCESS
//
// Failing closed on the third case matters: if a bare Supabase signup ever
// happens, it must not inherit access by default.
//
// The server holds the service-role key, so RLS does not apply to its queries.
// That makes this file the real enforcement boundary: every request carrying a
// client id passes through requireClientAccess, and the client list is filtered
// per caller.
// =============================================================================
import { supabase } from './db.js'

const bearer = (req) => {
  const h = req.headers.authorization || ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

// Normalise whatever is in the metadata blob into a predictable shape.
export function readAccess(meta = {}) {
  const isAdmin = meta.is_admin === true
  const isUser = meta.is_user === true
  const clientIds = Array.isArray(meta.client_ids)
    ? meta.client_ids.map(String).filter(Boolean)
    : []
  return { isAdmin, isUser, clientIds }
}

// Resolve an access token → { id, email, fullName, role, clientIds, isAdmin }.
// Returns null for a missing/invalid token, or a user with neither flag set.
export async function resolveUser(token) {
  if (!token) return null

  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data?.user) return null

  const u = data.user
  const meta = u.user_metadata || {}
  const { isAdmin, isUser, clientIds } = readAccess(meta)

  // Authenticated with Supabase but never granted workspace access.
  if (!isAdmin && !isUser) return null

  return {
    id: u.id,
    email: u.email || '',
    fullName: meta.full_name || '',
    role: isAdmin ? 'admin' : 'user',
    clientIds: isAdmin ? [] : clientIds,
    isAdmin,
  }
}

// Attach req.auth or 401.
export async function requireAuth(req, res, next) {
  try {
    const user = await resolveUser(bearer(req))
    if (!user) return res.status(401).json({ error: 'Not signed in' })
    req.auth = user
    next()
  } catch {
    res.status(401).json({ error: 'Not signed in' })
  }
}

export function requireAdmin(req, res, next) {
  if (!req.auth?.isAdmin) return res.status(403).json({ error: 'Admins only' })
  next()
}

// Shared-secret gate for external cron / automation callers (no user JWT).
// Accepts Authorization: Bearer <CRON_SECRET> or x-cron-secret: <CRON_SECRET>.
export function requireCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not configured' })
  const fromBearer = bearer(req)
  const fromHeader = String(req.headers['x-cron-secret'] || '').trim()
  const provided = fromBearer || fromHeader
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

// Guards everything under /api/clients/:id — the single chokepoint for
// per-client data. Mounted with app.use, so it covers every nested route
// (ideas, photos, posts, research, generation, …) without touching them.
export function requireClientAccess(req, res, next) {
  const id = req.params.clientId || req.params.id
  if (!id) return res.status(400).json({ error: 'Missing client id' })
  if (req.auth?.isAdmin) return next()
  if (req.auth?.clientIds?.includes(id)) return next()
  // 404 rather than 403: don't confirm that a client id exists to someone who
  // isn't allowed to see it.
  return res.status(404).json({ error: 'Client not found' })
}

// Narrow a client list to what the caller may see.
export const visibleClients = (auth, rows) =>
  auth.isAdmin ? rows : rows.filter((c) => auth.clientIds.includes(c.id))

// --- admin helpers ----------------------------------------------------------

// listUsers is paginated (50/page by default); walk it so a growing team doesn't
// silently truncate.
export async function listAllAuthUsers() {
  const out = []
  for (let page = 1; page <= 40; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(error.message)
    const batch = data?.users || []
    out.push(...batch)
    if (batch.length < 200) break
  }
  return out
}

// Metadata writes must read-modify-write: GoTrue replaces `user_metadata`
// wholesale, so sending only the changed keys would drop the rest.
export async function patchUserMetadata(userId, patch) {
  const { data, error } = await supabase.auth.admin.getUserById(userId)
  if (error || !data?.user) throw new Error(error?.message || 'User not found')
  const merged = { ...(data.user.user_metadata || {}), ...patch }
  const { data: updated, error: upErr } =
    await supabase.auth.admin.updateUserById(userId, { user_metadata: merged })
  if (upErr) throw new Error(upErr.message)
  return updated.user
}

// Shape an auth user for the admin Users table.
export const toUserRow = (u) => {
  const meta = u.user_metadata || {}
  const { isAdmin, clientIds } = readAccess(meta)
  return {
    id: u.id,
    email: u.email || '',
    fullName: meta.full_name || '',
    role: isAdmin ? 'admin' : 'user',
    clientIds: isAdmin ? [] : clientIds,
    createdAt: u.created_at,
    lastSignInAt: u.last_sign_in_at || null,
  }
}
