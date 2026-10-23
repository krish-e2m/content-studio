// =============================================================================
// server/socialStore.js
// Persistence for scraped social data.
//
//   channel state  → clients.social_media_accounts[].stats   (one source of
//                    truth: the handle you configure and what the scrape found
//                    live on the same entry)
//   posts          → social_posts
//   history series → social_snapshots
//   images         → Supabase Storage, via mediaCache.js
//
// This replaced a JSON file on disk. getLatest/getHistory still hand back
// exactly the shapes the API and React client already expect, so nothing
// upstream needed rewiring.
//
// TWO THINGS WORTH KNOWING
//
// 1. Posts ACCUMULATE. A scrape returns only the 10 most recent, and the file
//    cache replaced its list wholesale each refresh, so anything older was lost
//    the moment an account posted again. Here posts upsert on
//    (client, platform, external_id): counts on known posts update in place,
//    new ones are added, nothing is dropped. Over time that turns a 10-post
//    sample into a real one — which is what the timing heatmap needs.
//
// 2. Channel stats are committed ONCE per refresh, not once per channel.
//    social_media_accounts is a single jsonb column, so every write is a
//    read-modify-write of the whole array. The refresh scrapes channels in
//    parallel; if each wrote its own result the last writer would clobber the
//    others and two channels would silently lose their metrics. So
//    saveSnapshot/saveError only RETURN a patch, and commitChannelStats writes
//    them all in one go.
// =============================================================================

import { supabase } from './db.js'
import { mirrorImage, avatarPath, thumbPath, removeMediaPrefix } from './mediaCache.js'
import { log } from './logger.js'

// How many posts a channel hands back. The archive itself is unbounded; this
// only bounds the payload. Well above the 8 the grid shows, because the timing
// heatmap reads every post it is given and gets better the more it has.
const POSTS_PER_CHANNEL = 200
const MAX_SNAPSHOTS = 180

const int = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)

// ─── clients.social_media_accounts helpers ──────────────────────────────────
async function readAccounts(clientId) {
  const { data, error } = await supabase
    .from('clients').select('social_media_accounts').eq('id', clientId).single()
  if (error) throw new Error(error.message)
  return Array.isArray(data?.social_media_accounts) ? data.social_media_accounts : []
}

const platformOf = (entry) => String(entry?.platform || '').toLowerCase()

// ─── Row → UI shape ─────────────────────────────────────────────────────────
// The client speaks camelCase and knows nothing about column names, so the
// mapping lives here rather than leaking snake_case into the React tree.
function toAccount(entry) {
  const s = entry.stats || {}
  const handle = entry.handle || ''
  return {
    platform: platformOf(entry),
    handle,
    name: s.name || handle,
    profileUrl: s.profileUrl || entry.url || null,
    avatarUrl: s.avatarUrl ?? null,
    followers: s.followers ?? null,
    following: s.following ?? null,
    postsCount: s.postsCount ?? null,
    verified: !!s.verified,
  }
}

const toPost = (r) => ({
  platform: r.platform,
  externalId: r.external_id,
  url: r.url,
  caption: r.caption || '',
  title: r.title || '',
  publishedAt: r.published_at,
  thumbUrl: r.thumb_url,
  videoUrl: r.video_url,
  isVideo: !!r.is_video,
  likes: r.likes,
  comments: r.comments,
  shares: r.shares,
  views: r.views,
  commentThread: Array.isArray(r.comment_thread) ? r.comment_thread : [],
})

function totals(posts = []) {
  return posts.reduce((a, p) => ({
    likes: a.likes + (p.likes || 0),
    comments: a.comments + (p.comments || 0),
    shares: a.shares + (p.shares || 0),
    views: a.views + (p.views || 0),
  }), { likes: 0, comments: 0, shares: 0, views: 0 })
}

// ─── Write ──────────────────────────────────────────────────────────────────
/**
 * Store one platform's scrape: mirror its images, upsert its posts, append a
 * history point.
 *
 * Returns { platform, stats } — the channel patch. It is NOT written here; the
 * caller collects every channel's patch and passes them to commitChannelStats
 * in one write. See the header note about the jsonb read-modify-write race.
 */
export async function saveSnapshot(clientId, platform, payload) {
  const at = new Date().toISOString()
  const account = payload?.account || null

  // One scrape can hand back the same post twice — an actor paginating with
  // overlap, or a LinkedIn repost carrying the original's activity urn.
  // Postgres refuses an upsert whose batch hits the same conflict target twice
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time",
  // SQLSTATE 21000) and that error fails the WHOLE channel, not just the
  // duplicate row. Collapse them up front; the later copy wins, since actors
  // tend to return the freshest counts last.
  const byId = new Map()
  for (const p of payload?.posts || []) byId.set(String(p.externalId), p)
  const scraped = [...byId.values()]

  // Previous stats tell us whether the avatar still points at the same CDN
  // object — if it does, there is nothing to re-download.
  const accounts = await readAccounts(clientId)
  const prevStats = accounts.find((e) => platformOf(e) === platform)?.stats || {}

  let avatar = {
    url: prevStats.avatarUrl ?? null,
    path: prevStats.avatarPath ?? null,
    sourceUrl: prevStats.avatarSourceUrl ?? null,
  }
  if (account?.avatarUrl && account.avatarUrl !== prevStats.avatarSourceUrl) {
    avatar = (await mirrorImage(account.avatarUrl, avatarPath(clientId, platform))) || avatar
  }

  // ── posts ──
  let postsNew = 0
  if (scraped.length) {
    const ids = scraped.map((p) => String(p.externalId))
    const { data: prevPosts } = await supabase
      .from('social_posts')
      .select('external_id, thumb_url, thumb_path, thumb_source_url')
      .eq('client_id', clientId).eq('platform', platform)
      .in('external_id', ids)
    const prevById = new Map((prevPosts || []).map((r) => [r.external_id, r]))
    postsNew = ids.filter((id) => !prevById.has(id)).length

    // Mirror only the thumbnails whose source URL actually changed, so a
    // re-refresh of unchanged posts costs no bandwidth.
    const rows = await Promise.all(scraped.map(async (p) => {
      const externalId = String(p.externalId)
      const prev = prevById.get(externalId)
      let thumb = {
        url: prev?.thumb_url ?? null,
        path: prev?.thumb_path ?? null,
        sourceUrl: prev?.thumb_source_url ?? null,
      }
      if (p.thumbUrl && p.thumbUrl !== prev?.thumb_source_url) {
        thumb = (await mirrorImage(p.thumbUrl, thumbPath(clientId, platform, externalId))) || thumb
      }
      return {
        client_id: clientId,
        platform,
        external_id: externalId,
        url: p.url ?? null,
        caption: p.caption || '',
        title: p.title || '',
        published_at: p.publishedAt ?? null,
        likes: int(p.likes),
        comments: int(p.comments),
        shares: int(p.shares),
        views: int(p.views),
        is_video: !!p.isVideo,
        ...(Array.isArray(p.commentThread)
          ? { comment_thread: p.commentThread.slice(0, 50) }
          : {}),
        thumb_url: thumb.url,
        thumb_path: thumb.path,
        thumb_source_url: thumb.sourceUrl,
        video_url: p.videoUrl ?? null,
        last_scraped_at: at,
        // first_seen_at is deliberately absent: the column default fills it on
        // insert, and an upsert that doesn't name it leaves it alone.
      }
    }))

    let { error } = await supabase
      .from('social_posts')
      .upsert(rows, { onConflict: 'client_id,platform,external_id' })
    // comment_thread landed in a later migration. If this project hasn't
    // applied it yet, drop the column and retry so the scrape itself still
    // saves — the thread just won't persist until the migration runs.
    if (error && /comment_thread/i.test(error.message)) {
      for (const r of rows) delete r.comment_thread
      ;({ error } = await supabase
        .from('social_posts')
        .upsert(rows, { onConflict: 'client_id,platform,external_id' }))
    }
    if (error) {
      log.error(`[socialStore:${platform}] posts upsert failed`, error.message)
      throw new Error(`social_posts upsert: ${error.message}`)
    }
    log.info(`[socialStore:${platform}] posts saved`, { upserted: rows.length, postsNew })
  }

  // ── history point ──
  // Computed from THIS scrape's posts, so the series stays a like-for-like
  // reading rather than drifting upward as the archive grows.
  if (account) {
    const t = totals(scraped)
    const { error } = await supabase.from('social_snapshots').insert({
      client_id: clientId,
      platform,
      captured_at: at,
      followers: int(account.followers),
      posts_count: scraped.length,
      engagement_rate: payload?.engagementRate ?? null,
      likes_total: t.likes,
      comments_total: t.comments,
      shares_total: t.shares,
      views_total: t.views,
    })
    // A missing history point isn't worth failing an otherwise good scrape.
    if (error) log.warn(`[socialStore:${platform}] snapshot insert failed`, error.message)
    else log.info(`[socialStore:${platform}] snapshot saved`, { followers: int(account.followers), posts: scraped.length })
  }

  return {
    platform,
    stats: {
      name: account?.name ?? null,
      profileUrl: account?.profileUrl ?? null,
      avatarUrl: avatar.url,
      avatarPath: avatar.path,
      avatarSourceUrl: avatar.sourceUrl,
      followers: int(account?.followers),
      following: int(account?.following),
      postsCount: int(account?.postsCount),
      verified: !!account?.verified,
      engagementRate: payload?.engagementRate ?? null,
      postsFound: scraped.length,
      postsNew,
      lastRunAt: at,
      // A successful scrape clears the previous failure.
      lastError: null,
      lastErroredAt: null,
    },
  }
}

/**
 * Patch for a failed scrape. Keeps whatever was scraped last time — stale real
 * data beats an empty channel — and only stamps the error on top.
 */
export function saveError(clientId, platform, message) {
  return {
    platform,
    stats: { lastError: message, lastErroredAt: new Date().toISOString() },
    merge: true,
  }
}

/**
 * Write every channel patch from one refresh in a single update, so parallel
 * scrapes can't clobber each other's metrics.
 */
export async function commitChannelStats(clientId, patches = []) {
  if (!patches.length) return
  const accounts = await readAccounts(clientId)
  const byPlatform = new Map(patches.map((p) => [p.platform, p]))
  const unmatched = patches.filter((p) => !accounts.some((e) => platformOf(e) === p.platform))
  if (unmatched.length) {
    log.warn('[socialStore] stats patch has no matching account row — UI will not show it', {
      platforms: unmatched.map((p) => p.platform),
      accounts: accounts.map((e) => e?.platform),
    })
  }

  const next = accounts.map((entry) => {
    const patch = byPlatform.get(platformOf(entry))
    if (!patch) return entry
    return {
      ...entry,
      // A failure merges onto the previous stats; a success replaces them.
      stats: patch.merge ? { ...(entry.stats || {}), ...patch.stats } : patch.stats,
    }
  })

  const { error } = await supabase
    .from('clients').update({ social_media_accounts: next }).eq('id', clientId)
  if (error) {
    log.error('[socialStore] channel stats update failed', error.message)
    throw new Error(`channel stats update: ${error.message}`)
  }
  log.info('[socialStore] channel stats committed', {
    platforms: patches.map((p) => p.platform),
    ok: patches.filter((p) => !p.merge).map((p) => p.platform),
    errors: patches.filter((p) => p.merge).map((p) => p.platform),
  })
}

// ─── Read ───────────────────────────────────────────────────────────────────
/** Latest scrape for every platform of a client, keyed by platform. */
export async function getLatest(clientId) {
  const accounts = await readAccounts(clientId)
  // Only entries that have actually been scraped — a configured-but-never-run
  // handle has no metrics to report and shouldn't look like a live channel.
  const scraped = accounts.filter((e) => e?.stats && (e.stats.lastRunAt || e.stats.lastError))
  if (!scraped.length) return {}

  const { data: posts } = await supabase
    .from('social_posts')
    .select('*')
    .eq('client_id', clientId)
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(POSTS_PER_CHANNEL * Math.max(1, scraped.length))

  const byPlatform = new Map()
  for (const p of posts || []) {
    const list = byPlatform.get(p.platform) || []
    if (list.length < POSTS_PER_CHANNEL) list.push(toPost(p))
    byPlatform.set(p.platform, list)
  }

  const out = {}
  for (const entry of scraped) {
    const platform = platformOf(entry)
    const s = entry.stats || {}
    out[platform] = {
      // A channel that has only ever errored has no account to show.
      account: s.lastRunAt ? toAccount(entry) : null,
      posts: byPlatform.get(platform) || [],
      engagementRate: s.engagementRate ?? null,
      fetchedAt: s.lastRunAt ?? null,
      ...(s.lastError ? { error: s.lastError, erroredAt: s.lastErroredAt } : {}),
    }
  }
  return out
}

/** Snapshot series per platform, oldest first, for the trend lines. */
export async function getHistory(clientId) {
  const { data, error } = await supabase
    .from('social_snapshots')
    .select('platform, captured_at, followers, posts_count, engagement_rate, likes_total, comments_total, shares_total, views_total')
    .eq('client_id', clientId)
    .order('captured_at', { ascending: true })
    .limit(MAX_SNAPSHOTS * 5)
  if (error) throw new Error(error.message)

  const out = {}
  for (const r of data || []) {
    ;(out[r.platform] ||= []).push({
      at: r.captured_at,
      followers: r.followers,
      posts: r.posts_count,
      engagementRate: r.engagement_rate == null ? null : Number(r.engagement_rate),
      likes: Number(r.likes_total || 0),
      comments: Number(r.comments_total || 0),
      shares: Number(r.shares_total || 0),
      views: Number(r.views_total || 0),
    })
  }
  for (const k of Object.keys(out)) out[k] = out[k].slice(-MAX_SNAPSHOTS)
  return out
}

/**
 * Drop every scraped trace of a client. Rows go by FK cascade when the client
 * itself is deleted, but Storage objects never cascade — so the bucket has to
 * be swept explicitly or the mirrored images outlive the client forever.
 */
export async function clearClient(clientId) {
  await removeMediaPrefix(String(clientId))
  await supabase.from('social_snapshots').delete().eq('client_id', clientId)
  await supabase.from('social_posts').delete().eq('client_id', clientId)
}

/** Strip scraped stats from a client's channels without touching the handles. */
export async function clearChannelStats(clientId) {
  const accounts = await readAccounts(clientId)
  if (!accounts.length) return
  const next = accounts.map(({ stats, ...entry }) => entry)  // eslint-disable-line no-unused-vars
  await supabase.from('clients').update({ social_media_accounts: next }).eq('id', clientId)
}