// =============================================================================
// server/apify.js
// Live social data via Apify actors.
//
// WHAT THIS CAN AND CANNOT RETURN
// Apify actors scrape the *public* web. That yields follower counts, post
// captions, likes, comments, shares and (where the platform shows them) view
// counts. It cannot yield owner-only analytics — reach, impressions, saves,
// profile views, email open rates — because those never appear publicly and
// only come from an authenticated first-party API. The Performance UI is
// built against the public set only, so nothing on screen is invented.
//
// ACTOR IDS ARE CONFIGURABLE. Apify actor slugs change and paid alternatives
// exist for the same job, so every actor is overridable via env rather than
// hardcoded. Defaults below are the common public actors; if one is renamed
// or you prefer another, set the matching APIFY_ACTOR_* var and restart —
// no code change needed.
// =============================================================================

import { createHash } from 'node:crypto'
import { log } from './logger.js'

const API_BASE = 'https://api.apify.com/v2'

// Apify caps synchronous runs at 300s and returns 408 past that.
const SYNC_TIMEOUT_MS = Number(process.env.APIFY_TIMEOUT_MS || 240000)
// clockworks/tiktok-scraper routinely overruns the sync cap (especially once
// comments are in play), so TikTok runs are started async and polled instead.
const TIKTOK_TIMEOUT_MS = Number(process.env.APIFY_TIKTOK_TIMEOUT_MS || 480000)
const ASYNC_PLATFORMS = new Set(['tiktok', 'substack'])

function apifyLog(level, platform, msg, extra) {
  const tag = platform ? `[apify:${platform}]` : '[apify]'
  const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'
  log[fn](`${tag} ${msg}`, extra)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Hard ceiling on how many posts a single scrape may pull, per platform.
// Apify bills per result, so this is a cost guard as much as a speed one — a
// caller asking for more is clamped down to it rather than being trusted.
export const MAX_POSTS = 10

const ACTORS = {
  instagram_profile: process.env.APIFY_ACTOR_INSTAGRAM_PROFILE || 'apify~instagram-profile-scraper',
  instagram_posts:   process.env.APIFY_ACTOR_INSTAGRAM_POSTS   || 'apify~instagram-post-scraper',
  linkedin_profile:  process.env.APIFY_ACTOR_LINKEDIN_PROFILE  || 'apimaestro~linkedin-company-detail',
  linkedin_posts:    process.env.APIFY_ACTOR_LINKEDIN_POSTS    || 'apimaestro~linkedin-company-posts',
  // apidojo's X actors refuse API-triggered runs on an Apify Free Plan: they
  // exit SUCCEEDED but write a {demo:true} / {noResults:true} placeholder
  // instead of data, so the channel looked connected and stayed empty. These
  // two run fine over the API and return real figures.
  x_profile:         process.env.APIFY_ACTOR_X_PROFILE         || 'clappi~x-twitter-profile-scraper',
  x_posts:           process.env.APIFY_ACTOR_X_POSTS           || 'scraper_one~x-profile-posts-scraper',
  // Substack is posts-only: this one actor returns the publication's name,
  // subscriber count and avatar on every post row, so a second profile run
  // would scrape the same page twice and bill for it. See PROFILE_OPTIONAL.
  substack_posts:    process.env.APIFY_ACTOR_SUBSTACK_POSTS    || 'automation-lab~substack-scraper',
  // clockworks' TikTok actor returns authorMeta (followers, avatar, name) on
  // every video row, so a second profile run would scrape the same page twice.
  tiktok_posts:      process.env.APIFY_ACTOR_TIKTOK_POSTS      || 'clockworks~tiktok-scraper',
  // Comment *text* is a separate dataset (and a separate billable actor). The
  // posts run can request a few via commentsPerPost; if that comes back empty
  // we fall back to this dedicated comments actor against the video URLs.
  tiktok_comments:     process.env.APIFY_ACTOR_TIKTOK_COMMENTS     || 'clockworks~tiktok-comments-scraper',
  instagram_comments:  process.env.APIFY_ACTOR_INSTAGRAM_COMMENTS  || 'apify~instagram-comment-scraper',
  linkedin_comments:   process.env.APIFY_ACTOR_LINKEDIN_COMMENTS   || 'apimaestro~linkedin-post-comments-replies-engagements-scraper-no-cookies',
  x_comments:          process.env.APIFY_ACTOR_X_COMMENTS          || 'scraper_one~x-post-replies-scraper',
}

export const SUPPORTED_PLATFORMS = ['instagram', 'linkedin', 'x', 'substack', 'tiktok']

// How many comment texts to pull per post. Counts come with the post for free;
// the actual threads cost extra results (and a second actor on IG / LI / X /
// TikTok). 0 disables comment-text scraping but still stores the count.
function envCommentLimit() {
  const raw = process.env.APIFY_COMMENTS_PER_POST ?? process.env.APIFY_TIKTOK_COMMENTS_PER_POST
  if (raw === undefined || raw === null || String(raw).trim() === '') return 12
  const n = Number(raw)
  return Number.isFinite(n) ? n : 12
}
export const COMMENTS_PER_POST = Math.max(0, Math.min(40, envCommentLimit()))

// Platforms that have a dedicated Apify comment/replies actor (Substack embeds
// comments in its posts actor via includeComments instead).
const DEDICATED_COMMENT_PLATFORMS = new Set(['instagram', 'linkedin', 'x', 'tiktok'])

// Platforms whose posts actor also carries the profile, so fetchPlatform skips
// the separate profile run and derives the account from the first post.
const PROFILE_OPTIONAL = new Set(['substack', 'tiktok'])

export class ApifyError extends Error {
  constructor(message, { status, platform, actor } = {}) {
    super(message)
    this.name = 'ApifyError'
    this.status = status
    this.platform = platform
    this.actor = actor
  }
}

function token() {
  const t = process.env.APIFY_TOKEN
  if (!t) {
    throw new ApifyError(
      'APIFY_TOKEN is not set. Add it to your .env (get one from Apify Console → Settings → Integrations) and restart the server.',
      { status: 503 },
    )
  }
  return t
}

// ─── Field plucking ─────────────────────────────────────────────────────────
// Actors disagree on field names for the same value (followersCount vs
// followers vs followersAmount). Rather than bind to one actor's exact schema,
// read the first candidate key that carries a usable value — so swapping the
// actor via env has a good chance of still working.
// Walks a dotted path, transparently stepping *into* arrays: the first element
// that resolves the rest of the path wins. Actors disagree not only on field
// names but on shape — the same attachment is a scalar on one actor, an object
// on another and a list on a third — so one traversal has to handle all three.
function walk(node, parts) {
  if (node === undefined || node === null) return undefined
  if (!parts.length) return node
  if (Array.isArray(node)) {
    for (const el of node) {
      const v = walk(el, parts)
      if (v !== undefined && v !== null && v !== '') return v
    }
    return undefined
  }
  if (typeof node !== 'object') return undefined
  const [head, ...rest] = parts
  return walk(node[head], rest)
}

function pick(obj, keys, fallback = null) {
  if (!obj) return fallback
  for (const k of keys) {
    const v = walk(obj, k.split('.'))
    if (v !== undefined && v !== null && v !== '') return v
  }
  return fallback
}

// Media keys can hold a URL string, an object wrapping one, or a list of
// attachments — dig out the first usable http(s) URL from whichever it is.
const URL_KEYS = [
  'url', 'src', 'uri', 'href', 'link', 'thumbnail', 'thumbnailUrl', 'thumbnail_url',
  'displayUrl', 'display_url', 'image', 'imageUrl', 'image_url', 'media_url_https',
  'media_url', 'mediaUrlHttps', 'photo_image', 'preview', 'previewUrl', 'poster', 'largeImageURL',
]

function firstUrl(v, depth = 0) {
  if (!v || depth > 4) return null
  if (typeof v === 'string') {
    const s = v.trim()
    return /^https?:\/\//i.test(s) ? s : null
  }
  if (Array.isArray(v)) {
    for (const el of v) {
      const u = firstUrl(el, depth + 1)
      if (u) return u
    }
    return null
  }
  if (typeof v === 'object') {
    for (const k of URL_KEYS) {
      const u = firstUrl(v[k], depth + 1)
      if (u) return u
    }
  }
  return null
}

/** pick(), but every candidate is reduced to a bare http(s) URL. */
function pickUrl(obj, keys) {
  if (!obj) return null
  for (const k of keys) {
    const u = firstUrl(walk(obj, k.split('.')))
    if (u) return u
  }
  return null
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    // Handles "12.3K", "1,234", "2.1M" as rendered on public profiles.
    const s = v.trim().replace(/,/g, '')
    const m = s.match(/^([\d.]+)\s*([KMB])?$/i)
    if (m) {
      const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1
      const n = parseFloat(m[1])
      if (Number.isFinite(n)) return Math.round(n * mult)
    }
    const n = parseFloat(s)
    if (Number.isFinite(n)) return n
  }
  return null
}

function isoDate(v) {
  if (!v) return null
  try {
    const d = new Date(typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : v)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  } catch { return null }
}

// Onboarding often leaves a filler value in the handle field rather than
// blanking it. Treating "NA" as a real handle would scrape the wrong profile
// and bill an Apify run for it, so these are rejected the same as empty.
const PLACEHOLDER_HANDLES = new Set([
  'na', 'n/a', 'n.a', 'none', 'null', 'nil', 'tbd', 'tba', '-', '--', '.',
  'x', 'xx', 'xxx', 'test', 'todo', 'pending', 'nan', 'undefined',
  // Platform roots, not accounts. A bare "https://substack.com/" left in the
  // url field would otherwise scrape the homepage and quietly return nothing.
  'substack.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com',
  'tiktok.com', 'www.tiktok.com', 'vm.tiktok.com',
])

// Strip a leading @ and any profile-URL wrapper down to a bare handle.
// Returns '' for anything that isn't a usable handle.
export function bareHandle(input, platform) {
  let s = String(input || '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      if (platform === 'substack') {
        // Two valid shapes, and they disagree about where the publication is:
        //   foo.substack.com / newsletter.example.com → the HOST is the name
        //   substack.com/@someone                     → the PATH is the name
        // Reading the host unconditionally turns the second form into bare
        // "substack.com", which is the homepage — the actor scrapes it happily
        // and returns nothing.
        const host = u.hostname.replace(/^www\./i, '')
        const seg = u.pathname.split('/').filter(Boolean)[0] || ''
        s = host === 'substack.com' ? seg : host
      } else {
        const parts = u.pathname.split('/').filter(Boolean)
        // A bare profile root (instagram.com/) carries no handle at all.
        // TikTok video URLs are /@user/video/<id> — the @user segment is the
        // profile, not "video" or the numeric id.
        s = parts.filter((p) => !['company', 'in', 'pages', 'people', 'video', 'photo'].includes(p.toLowerCase()) && !/^\d+$/.test(p))[0] || parts[0] || ''
      }
    } catch { /* fall through to raw string */ }
  }
  s = s.replace(/^@/, '').replace(/\/$/, '').trim()
  if (!s) return ''
  // Reject fillers, and anything too short to be a real profile name.
  if (PLACEHOLDER_HANDLES.has(s.toLowerCase())) return ''
  if (s.length < 2) return ''
  return s
}

// ─── Actor invocation ───────────────────────────────────────────────────────
function inputSummary(input) {
  if (!input || typeof input !== 'object') return input
  const keys = ['profiles', 'profileUrls', 'usernames', 'username', 'urls', 'postURLs',
    'resultsPerPage', 'resultsLimit', 'limit', 'commentsPerPost', 'company_name', 'identifier']
  const out = {}
  for (const k of keys) if (input[k] !== undefined) out[k] = input[k]
  return out
}

async function parseApifyError(res, actorId, platform) {
  const body = await res.text().catch(() => '')
  let detail = body.slice(0, 400)
  try { detail = JSON.parse(body)?.error?.message || JSON.parse(body)?.error?.type || detail } catch { /* keep raw text */ }
  const hint = res.status === 404
    ? ` Actor "${actorId}" was not found — set the matching APIFY_ACTOR_* env var to a valid actor.`
    : res.status === 402 ? ' Your Apify account is out of credits.'
    : res.status === 401 ? ' APIFY_TOKEN was rejected.'
    : res.status === 408 ? ' Sync run hit Apify’s 300s cap — TikTok should be using the async path.'
    : ''
  return new ApifyError(`Apify run failed (${res.status}).${hint} ${detail}`.trim(), { status: res.status, platform, actor: actorId })
}

function summarizeItems(items) {
  const list = Array.isArray(items) ? items : []
  const errors = list.filter((i) => i?.errorCode)
  const sample = list[0] && !list[0].errorCode
    ? Object.keys(list[0]).slice(0, 12)
    : (list[0] ? { errorCode: list[0].errorCode, error: list[0].error } : null)
  return { items: list.length, errors: errors.length, sampleKeys: sample }
}

async function runActorSync(actorId, input, { platform } = {}) {
  const auth = token()
  const t0 = Date.now()
  apifyLog('log', platform, `sync start ${actorId}`, inputSummary(input))

  const url = `${API_BASE}/acts/${actorId}/run-sync-get-dataset-items`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS)

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth}`,
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    const elapsed = Math.round((Date.now() - t0) / 1000)
    if (err.name === 'AbortError') {
      apifyLog('error', platform, `sync timed out after ${elapsed}s`, { actor: actorId })
      throw new ApifyError(`Scrape timed out after ${Math.round(SYNC_TIMEOUT_MS / 1000)}s.`, { status: 504, platform, actor: actorId })
    }
    apifyLog('error', platform, `sync network error after ${elapsed}s: ${err.message}`, { actor: actorId })
    throw new ApifyError(`Could not reach Apify: ${err.message}`, { status: 502, platform, actor: actorId })
  }
  clearTimeout(timer)

  if (!res.ok) {
    const err = await parseApifyError(res, actorId, platform)
    apifyLog('error', platform, `sync failed ${res.status} in ${Math.round((Date.now() - t0) / 1000)}s`, err.message)
    throw err
  }

  const items = await res.json().catch(() => [])
  const list = Array.isArray(items) ? items : []
  apifyLog('log', platform, `sync ok ${actorId} in ${Math.round((Date.now() - t0) / 1000)}s`, summarizeItems(list))
  return list
}

async function runActorAndWait(actorId, input, { platform, timeoutMs } = {}) {
  const auth = token()
  const t0 = Date.now()
  const budget = timeoutMs || TIKTOK_TIMEOUT_MS
  apifyLog('log', platform, `async start ${actorId} (poll up to ${Math.round(budget / 1000)}s)`, inputSummary(input))

  const startRes = await fetch(`${API_BASE}/acts/${actorId}/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth}`,
    },
    body: JSON.stringify(input),
  }).catch((err) => {
    apifyLog('error', platform, `async start network error: ${err.message}`, { actor: actorId })
    throw new ApifyError(`Could not reach Apify: ${err.message}`, { status: 502, platform, actor: actorId })
  })

  if (!startRes.ok) {
    const err = await parseApifyError(startRes, actorId, platform)
    apifyLog('error', platform, `async start failed ${startRes.status}`, err.message)
    throw err
  }

  const started = await startRes.json().catch(() => ({}))
  const runId = started?.data?.id
  const datasetId = started?.data?.defaultDatasetId
  if (!runId) {
    apifyLog('error', platform, 'async start returned no run id', started)
    throw new ApifyError('Apify did not return a run id.', { status: 502, platform, actor: actorId })
  }
  apifyLog('log', platform, `async run ${runId} started`, { datasetId })

  const terminal = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'])
  let status = started?.data?.status || 'RUNNING'
  let lastLog = 0
  while (!terminal.has(status)) {
    if (Date.now() - t0 > budget) {
      apifyLog('error', platform, `async timed out after ${Math.round((Date.now() - t0) / 1000)}s (run still ${status})`, { runId, actor: actorId })
      throw new ApifyError(`Scrape timed out after ${Math.round(budget / 1000)}s (Apify run ${runId} still ${status}).`, { status: 504, platform, actor: actorId })
    }
    await sleep(5000)
    const runRes = await fetch(`${API_BASE}/actor-runs/${runId}`, {
      headers: { Authorization: `Bearer ${auth}` },
    }).catch((err) => {
      apifyLog('warn', platform, `async poll error: ${err.message}`, { runId })
      return null
    })
    if (!runRes?.ok) continue
    const run = await runRes.json().catch(() => ({}))
    status = run?.data?.status || status
    if (Date.now() - lastLog > 20000) {
      apifyLog('log', platform, `async run ${runId} ${status} (${Math.round((Date.now() - t0) / 1000)}s)`)
      lastLog = Date.now()
    }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000)
  if (status !== 'SUCCEEDED') {
    const runRes = await fetch(`${API_BASE}/actor-runs/${runId}`, {
      headers: { Authorization: `Bearer ${auth}` },
    }).catch(() => null)
    const run = runRes ? await runRes.json().catch(() => ({})) : {}
    const why = run?.data?.statusMessage || run?.data?.statusReason || status
    apifyLog('error', platform, `async run ${runId} ${status} in ${elapsed}s`, why)
    throw new ApifyError(`Apify run ${status}: ${why}`, { status: 502, platform, actor: actorId })
  }

  const itemsRes = await fetch(`${API_BASE}/datasets/${datasetId}/items?clean=true&limit=500`, {
    headers: { Authorization: `Bearer ${auth}` },
  })
  if (!itemsRes.ok) {
    const err = await parseApifyError(itemsRes, actorId, platform)
    apifyLog('error', platform, `async dataset fetch failed in ${elapsed}s`, err.message)
    throw err
  }
  const items = await itemsRes.json().catch(() => [])
  const list = Array.isArray(items) ? items : []
  apifyLog('log', platform, `async ok ${actorId} run ${runId} in ${elapsed}s`, summarizeItems(list))
  return list
}

async function runActor(actorId, input, { platform } = {}) {
  // Resolved before the try below so a missing token surfaces as its own 503
  // rather than being caught and relabelled as a network failure.
  token()
  if (ASYNC_PLATFORMS.has(platform)) {
    return runActorAndWait(actorId, input, { platform, timeoutMs: TIKTOK_TIMEOUT_MS })
  }
  return runActorSync(actorId, input, { platform })
}

// ─── Per-platform input builders ────────────────────────────────────────────
const PROFILE_INPUT = {
  instagram: (h) => ({ usernames: [h] }),
  // apimaestro's company-detail actor takes exactly one field, `identifier`,
  // and validates it as an array — a bare string 400s before the run starts.
  linkedin:  (h) => ({ identifier: [h] }),
  x:         (h) => ({ profileUrls: [`https://x.com/${h}`] }),
}

// 'foo' -> https://foo.substack.com ; 'news.example.com' -> https://news.example.com
const substackUrl = (h) => (h.includes('.') ? `https://${h}` : `https://${h}.substack.com`)

const POSTS_INPUT = {
  instagram: (h, limit) => ({ username: [h], resultsLimit: limit }),
  // The company-POSTS actor keys off `company_name`, not `identifier` — and it
  // has a default of "google", so getting this wrong doesn't fail loudly, it
  // quietly scrapes Google's feed and bills you for it.
  linkedin:  (h, limit) => ({ company_name: h, limit, page_number: 1, sort: 'recent' }),
  x:         (h, limit) => ({ profileUrls: [`https://x.com/${h}`], resultsLimit: limit, skipPinnedPosts: false }),
  substack:  (h, limit) => ({ urls: [substackUrl(h)], maxPostsPerNewsletter: limit,
                              includeContent: false, includeComments: COMMENTS_PER_POST > 0,
                              maxCommentsPerPost: COMMENTS_PER_POST, includePublicationInfo: true }),
  // profiles (not profileUrls) — that's the field clockworks validates. A
  // leading @ is accepted; resultsPerPage is the post cap; commentsPerPost
  // asks the same run to also pull comment text into commentsDatasetURL.
  tiktok:    (h, limit) => ({
    // Full profile URL is the shape clockworks is happiest with; a bare
    // handle sometimes gets treated as a search query and returns nothing.
    profiles: [`https://www.tiktok.com/@${h}`],
    resultsPerPage: limit,
    profileScrapeSections: ['videos'],
    profileSorting: 'latest',
    excludePinnedPosts: false,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadAvatars: false,
    shouldDownloadSlideshowImages: false,
    shouldDownloadSubtitles: false,
    // Comment *text* is a second actor — putting commentsPerPost here is what
    // pushed the posts run past Apify’s sync cap and made TikTok look empty.
    commentsPerPost: 0,
    maxRepliesPerComment: 0,
  }),
}

// ─── Normalizers → one shape for every platform ─────────────────────────────
function normalizeAccount(platform, raw, handle) {
  if (!raw) return null
  // LinkedIn's company actor returns nothing at the top level — name, follower
  // count and logo all live under basic_info/stats/media. Flat keys alone read
  // that profile as entirely empty, which is how a connected channel could
  // report ok with a null follower count.
  const followers = num(pick(raw, [
    'followersCount', 'followers', 'followersAmount', 'followerCount',
    'stats.follower_count', 'stats.followers', 'follower_count', 'subscriberCount',
    'likes', 'pageLikes', 'subscriberCount',
    // TikTok: authorMeta.fans is the public follower count. heart is total
    // likes across the account — do NOT read it as followers.
    'authorMeta.fans', 'authorMeta.followers', 'authorMeta.followerCount',
  ]))
  return {
    platform,
    handle,
    name: pick(raw, [
      'basic_info.name', 'publicationName', 'fullName', 'name', 'pageName', 'displayName', 'username',
      'authorMeta.nickName', 'authorMeta.nickname', 'authorMeta.name',
    ], handle),
    profileUrl: pick(raw, [
      'basic_info.linkedin_url', 'links.linkedin', 'publicationUrl', 'url', 'profileUrl', 'pageUrl', 'inputUrl', 'link',
      'authorMeta.profileUrl',
    ], { instagram: `https://instagram.com/${handle}`,
      linkedin: `https://linkedin.com/company/${handle}`,
      x: `https://x.com/${handle}`,
      tiktok: `https://www.tiktok.com/@${handle}` }[platform]),
    avatarUrl: pickUrl(raw, [
      'profilePicUrlHD', 'profilePicUrl', 'profilePicture', 'profile_pic_url', 'avatar',
      'profileImage', 'profileImageUrl', 'picture', 'logo', 'logoUrl', 'logo_url',
      'media.logo_url', 'avatar_url', 'avatar', 'authorPhotoUrl', 'image', 'profilePhoto', 'basic_info.profile_picture',
      'authorMeta.avatar', 'authorMeta.originalAvatarUrl',
    ]),
    followers,
    following: num(pick(raw, ['followsCount', 'following', 'followingCount', 'authorMeta.following'])),
    postsCount: num(pick(raw, ['postsCount', 'posts', 'statusesCount', 'statuses_count', 'mediaCount', 'authorMeta.video'])),
    verified: !!pick(raw, ['basic_info.is_verified', 'verified', 'isVerified', 'is_verified', 'is_blue_verified', 'authorMeta.verified'], false),
  }
}

// externalId is the deduplication key: social_posts is unique on
// (client_id, platform, external_id) and upserts against it. An actor that
// returns no recognisable id therefore MUST still produce a stable one — a
// random fallback can never collide, so the same post would be inserted afresh
// on every refresh and the archive would grow without bound. Derive it from
// whatever actually identifies the post instead: its URL, or failing that its
// timestamp plus the head of its caption.
function stableId(raw, caption) {
  const seed = pick(raw, ['url', 'postUrl', 'post_url', 'link', 'permalink', 'twitterUrl', 'webVideoUrl', 'videoWebUrl'])
    || `${pick(raw, ['timestamp', 'publishedAt', 'createdAt', 'date', 'time', 'postedAtISO', 'posted_at.timestamp', 'posted_at.date', 'createTimeISO'], '')}|${String(caption).slice(0, 120)}`
  return `sha:${createHash('sha1').update(String(seed)).digest('hex').slice(0, 20)}`
}

function normalizePost(platform, raw) {
  if (!raw) return null
  // stats.* covers LinkedIn, which reports every engagement number in a nested
  // block. total_reactions (not stats.like) is the figure LinkedIn itself shows.
  const likes = num(pick(raw, ['likesCount', 'likes', 'likeCount', 'reactionsCount', 'stats.total_reactions', 'reactions.total', 'favoriteCount', 'favouriteCount', 'reactionCount', 'diggCount']))
  // commentCount before `comments`: when an actor nests the thread under
  // `comments` (an array), pick would otherwise hand that array to num() and
  // we'd lose the numeric count sitting next to it.
  const comments = num(pick(raw, ['commentsCount', 'commentCount', 'stats.comments', 'repliesCount', 'replyCount', 'comments']))
  const shares = num(pick(raw, ['sharesCount', 'shares', 'shareCount', 'retweetCount', 'repostCount', 'stats.reposts', 'repostsCount', 'reshareCount', 'restacks']))
  const views = num(pick(raw, ['videoViewCount', 'viewCount', 'views', 'videoPlayCount', 'playCount', 'impressionsCount']))
  const caption = pick(raw, ['caption', 'text', 'message', 'content', 'subtitle', 'description', 'title', 'fullText', 'postText'], '') || ''
  // A newsletter issue has a real headline; a social post doesn't, and falls
  // back to the first line of its caption below.
  const headline = pick(raw, ['title', 'headline'], '') || ''

  // Every actor names and nests its media differently, and a post that is a
  // video usually still carries a poster frame under a *different* key than an
  // image post does. Missing all of them is why a channel could come back with
  // captions and counts but a blank tile, so the candidate list is deliberately
  // wide and walks into attachment/media arrays (see pickUrl).
  // LinkedIn puts photos and videos in the SAME place — media.items[].url is a
  // JPEG on an image post and an mp4 playlist on a video one. Only media.type
  // distinguishes them, so it has to gate the video lookup: without the gate
  // every photo post would be labelled a video.
  const mediaType = String(pick(raw, ['media.type'], '') || '').toLowerCase()

  const videoUrl = pickUrl(raw, [
    'videoUrl', 'video_url', 'videoUrls', 'videoPlayUrl', 'video.url', 'video',
    'media.video_info.variants', 'extendedEntities.media.video_info.variants',
    'stream_url', 'media.stream_url', 'videos', 'attachments.video',
    'videoMeta.downloadAddr', 'mediaUrls',
  ]) || (mediaType === 'video' ? pickUrl(raw, ['media.items.url']) : null)

  const thumbUrl = pickUrl(raw, [
    // Instagram
    'displayUrl', 'display_url', 'images', 'imageUrls', 'childPosts.displayUrl',
    'thumbnailUrl', 'thumbnail_url', 'thumbnailSrc',
    // Meta-style attachment shapes
    'media.thumbnail', 'media.photo_image.uri', 'media.image.uri',
    'attachments.thumbnail', 'attachments.image', 'attachments',
    'previewImage', 'postImage', 'photo',
    // LinkedIn — thumbnail first: on a video post it's the poster frame, and
    // media.items.url next to it is the mp4. document.* covers PDF carousels.
    'media.items.thumbnail', 'media.items.url', 'document.thumbnail',
    'article.image', 'image', 'imageUrl', 'images.url', 'video.thumbnail', 'coverUrl',
    // X
    'extendedEntities.media.media_url_https', 'entities.media.media_url_https',
    'media.media_url_https', 'card.thumbnail',
    // TikTok — poster frame; slideshows put stills under slideshowImageLinks.
    'videoMeta.coverUrl', 'videoMeta.originalCoverUrl', 'covers.default', 'covers.origin',
    'slideshowImageLinks.tiktokLink', 'slideshowImageLinks.downloadLink',
    // Substack
    'coverImage',
    // last resort
    'media', 'mediaUrl', 'picture', 'poster',
  ])

  const isSlideshow = pick(raw, ['isSlideshow', 'is_slideshow'], false) === true
  const isVideo = !!(
    videoUrl
    || pick(raw, ['isVideo', 'is_video'], false) === true
    || /^(video|reel|clips?)$/i.test(String(pick(raw, ['media.type', 'type', 'mediaType', 'productType', 'media_type', 'postType'], '')))
    || (platform === 'tiktok' && !isSlideshow)
  )

  return {
    platform,
    externalId: String(pick(raw, ['id', 'postId', 'shortCode', 'tweetId', 'urn', 'activity_urn', 'full_urn'], '') || stableId(raw, caption)),
    url: pick(raw, ['url', 'postUrl', 'post_url', 'link', 'permalink', 'twitterUrl', 'webVideoUrl', 'videoWebUrl']),
    caption,
    // First line doubles as a title in list views; captions have no title field.
    title: headline || caption.split('\n').find((l) => l.trim()) || '(no caption)',
    // A post with neither a date nor a url is dropped by the caller — so
    // missing LinkedIn's nested posted_at.* here is what silently emptied the
    // whole channel even when the actor returned ten good items.
    publishedAt: isoDate(pick(raw, [
      'timestamp', 'publishedAt', 'createdAt', 'date', 'time', 'postedAtISO',
      'posted_at.timestamp', 'posted_at.date', 'createTimeISO', 'createTime',
    ])),
    thumbUrl,
    videoUrl,
    isVideo,
    likes, comments, shares, views,
  }
}

// ─── Comment threads ────────────────────────────────────────────────────────
// Counts come for free on the post. Comment *text* is nested on some post
// actors (Instagram latestComments, Substack comments[]) and a second actor
// on the rest (TikTok / LinkedIn / X, and Instagram when the sample is empty).
function normalizeComment(raw) {
  if (!raw || raw.errorCode) return null
  // Video rows from the TikTok posts dataset also have `text` + like counts.
  if (pick(raw, ['authorMeta']) && !pick(raw, ['cid', 'commentId'])) return null
  const text = String(pick(raw, [
    'text', 'comment', 'commentText', 'content', 'body', 'message', 'fullText',
  ], '') || '').trim()
  if (!text) return null
  const handle = String(pick(raw, [
    'uniqueId', 'unique_id', 'ownerUsername', 'owner.username', 'handle',
    'author.handle', 'author.userName', 'author.username', 'user.uniqueId',
    'user.unique_id', 'userName', 'username', 'authorMeta.name', 'user',
  ], '') || '').replace(/^@/, '')
  const author = pick(raw, [
    'nickname', 'nickName', 'name', 'author.name', 'owner.full_name', 'ownerFullName',
    'authorMeta.nickName', 'user.nickname', 'user.nickName', 'ownerUsername',
    'author.userName', 'author.username',
  ], handle) || 'user'
  return {
    id: String(pick(raw, ['cid', 'commentId', 'comment_id', 'id'], '') || ''),
    author: String(author),
    handle,
    text,
    likes: num(pick(raw, [
      'diggCount', 'likes', 'likeCount', 'likesCount', 'reactionCount', 'stats.total_reactions',
    ])),
    publishedAt: isoDate(pick(raw, [
      'createTimeISO', 'createTime', 'createdAt', 'timestamp', 'create_time',
      'posted_at.timestamp', 'posted_at.date', 'date', 'publishedAt',
    ])),
  }
}

function flattenComments(list, out = []) {
  for (const c of list || []) {
    const n = normalizeComment(c)
    if (n) out.push(n)
    const replies = c?.replies || c?.children || c?.replyComments
    if (Array.isArray(replies) && replies.length) flattenComments(replies, out)
  }
  return out
}

function nestedCommentList(raw) {
  for (const k of ['latestComments', 'comments', 'commentList', 'topComments']) {
    const v = pick(raw, [k])
    if (Array.isArray(v) && v.length) return flattenComments(v)
  }
  const first = pick(raw, ['firstComment'])
  if (typeof first === 'string' && first.trim()) {
    const n = normalizeComment({ text: first })
    return n ? [n] : []
  }
  return []
}

// Join comments to posts across platforms: TikTok video id, IG shortcode,
// LinkedIn activity urn, X status id, or a stripped URL.
function postMatchKey(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  let m
  if ((m = s.match(/\/video\/(\d+)/))) return m[1]
  if ((m = s.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/))) return m[1]
  if ((m = s.match(/activity[:-](\d{10,})/i))) return m[1]
  if ((m = s.match(/urn:li:(?:activity|ugcPost):(\d+)/i))) return m[1]
  if ((m = s.match(/\/status\/(\d+)/))) return m[1]
  if (/^\d{5,}$/.test(s)) return s
  return s.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '').split('?')[0].toLowerCase()
}

function keysForPost(p) {
  return [...new Set([
    postMatchKey(p.externalId),
    postMatchKey(p.url),
    postMatchKey(p.id),
    postMatchKey(pick(p, [
      'webVideoUrl', 'videoWebUrl', 'postUrl', 'post_url', 'link', 'permalink',
      'twitterUrl', 'shortCode', 'shortcode', 'urn', 'activity_urn', 'full_urn',
      'tweetId', 'code', 'awemeId', 'videoId',
    ])),
  ].filter(Boolean))]
}

function keysForComment(c) {
  return [...new Set([
    postMatchKey(pick(c, [
      'postUrl', 'post_url', 'inputUrl', 'post_input', 'videoWebUrl', 'webVideoUrl',
      'inReplyToUrl', 'inReplyToId', 'inReplyToStatusId', 'replyToStatusId',
      'conversationId', 'postId', 'post_id', 'parentPostId', 'parent_post_id',
      'awemeId', 'videoId', 'postShortcode', 'shortCode', 'activity_urn', 'urn',
      'threadId', 'quotedStatusId',
    ])),
  ].filter(Boolean))]
}

/** Posts that still need the dedicated comment actor (LI/X never embed text). */
function postsNeedingCommentActor(platform, posts) {
  if (!DEDICATED_COMMENT_PLATFORMS.has(platform) || !COMMENTS_PER_POST) return []
  return posts.filter((p) => {
    if (!p.url) return false
    const have = p.commentThread?.length ?? 0
    const count = p.comments ?? 0
    const want = Math.min(COMMENTS_PER_POST, count || COMMENTS_PER_POST)
    if (platform === 'linkedin' || platform === 'x') {
      // Posts actors for these platforms never return reply text — always run
      // the comment actor when the public count says comments exist.
      return count > 0 && have < want
    }
    // IG / TikTok: run when nested/dataset text is missing or partial.
    return count > 0 && have < want
  })
}

async function fetchDatasetItems(datasetUrl, { platform, actor } = {}) {
  const auth = token()
  let url = String(datasetUrl || '').trim()
  if (!url) return []
  if (!/^https?:\/\//i.test(url)) {
    url = `${API_BASE}/datasets/${url}/items`
  } else if (!/\/items(?:\?|$)/i.test(url)) {
    url = `${url.replace(/\/$/, '')}/items`
  }
  const sep = url.includes('?') ? '&' : '?'
  url = `${url}${sep}clean=true&limit=500`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(SYNC_TIMEOUT_MS, 60000))
  let res
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${auth}` },
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      throw new ApifyError('Comments dataset fetch timed out.', { status: 504, platform, actor })
    }
    throw new ApifyError(`Could not reach Apify comments dataset: ${err.message}`, { status: 502, platform, actor })
  }
  clearTimeout(timer)
  if (!res.ok) return []
  const items = await res.json().catch(() => [])
  return Array.isArray(items) ? items : []
}

function pushComments(bucket, key, comments) {
  if (!key || !comments?.length) return
  const list = bucket.get(key) || []
  list.push(...comments)
  bucket.set(key, list)
}

const COMMENTS_INPUT = {
  tiktok:    (urls, limit) => ({ postURLs: urls, commentsPerPost: limit, maxRepliesPerComment: 0 }),
  instagram: (urls, limit) => ({ directUrls: urls, resultsLimit: limit }),
  linkedin:  (urls, limit) => ({ postIds: urls, sortOrder: 'most recent', limit }),
  x:         (urls, limit) => ({ postUrls: urls, resultsLimit: limit, includeOriginalPost: false }),
}

async function attachComments(platform, posts, postItems) {
  if (!COMMENTS_PER_POST || !posts.length) {
    apifyLog('log', platform, `comments skipped (perPost=${COMMENTS_PER_POST}, posts=${posts.length})`)
    return
  }
  apifyLog('log', platform, `comments: attaching up to ${COMMENTS_PER_POST} per post across ${posts.length} posts`)

  const byKey = new Map()

  for (const raw of postItems || []) {
    const thread = nestedCommentList(raw)
    if (!thread.length) continue
    for (const k of keysForPost(raw)) pushComments(byKey, k, thread)
  }

  const datasetUrls = [...new Set(
    (postItems || [])
      .map((r) => pick(r, ['commentsDatasetURL', 'commentsDatasetUrl', 'comments_dataset_url']))
      .filter(Boolean)
      .map(String),
  )]
  for (const u of datasetUrls) {
    try {
      const items = await fetchDatasetItems(u, { platform, actor: ACTORS[`${platform}_posts`] })
      for (const c of items) {
        const comment = normalizeComment(c)
        if (!comment) continue
        for (const k of keysForComment(c)) pushComments(byKey, k, [comment])
      }
      apifyLog('log', platform, `comments dataset → ${items.length} rows`)
    } catch (err) {
      apifyLog('warn', platform, `comments dataset failed: ${err.message}`)
    }
  }

  const apply = () => {
    for (const p of posts) {
      const thread = []
      for (const k of keysForPost(p)) thread.push(...(byKey.get(k) || []))
      const seen = new Set()
      const unique = []
      for (const c of thread) {
        const id = c.id || c.text
        if (!id || seen.has(id)) continue
        seen.add(id)
        unique.push(c)
      }
      if (unique.length) p.commentThread = unique.slice(0, COMMENTS_PER_POST)
    }
  }
  apply()

  const withThread = posts.filter((p) => p.commentThread?.length).length
  apifyLog('log', platform, `comments after nested/dataset: ${withThread}/${posts.length} posts have text`)

  const actorId = ACTORS[`${platform}_comments`]
  const inputFor = COMMENTS_INPUT[platform]
  const targets = postsNeedingCommentActor(platform, posts)

  if (!targets.length) {
    apifyLog('log', platform, 'comments actor skipped (all posts satisfied or none with public comments)')
    return
  }
  if (!actorId || !inputFor) {
    apifyLog('log', platform, `comments actor not configured; ${targets.length} post(s) still need text`)
    return
  }

  apifyLog('log', platform, `comments actor ${actorId} → ${targets.length} post(s)`, {
    urls: targets.map((p) => p.url).slice(0, 3),
  })
  try {
    // Comment actors scrape N posts × M comments and routinely overrun the
    // 300s sync cap, so they always start+poll rather than run-sync.
    const items = await runActorAndWait(
      actorId,
      inputFor(targets.map((p) => p.url), COMMENTS_PER_POST),
      { platform, timeoutMs: TIKTOK_TIMEOUT_MS },
    )
    let parsed = 0
    for (const c of items) {
      const comment = normalizeComment(c)
      if (!comment) continue
      parsed += 1
      const keys = keysForComment(c)
      if (!keys.length) {
        // Some comment actors omit the parent URL; attach to every target
        // only if there is exactly one, otherwise skip rather than
        // duplicating the same thread onto ten posts.
        if (targets.length === 1) keys.push(...keysForPost(targets[0]))
      }
      for (const k of keys) pushComments(byKey, k, [comment])
    }
    apply()
    const after = posts.filter((p) => p.commentThread?.length).length
    apifyLog('log', platform, `comments actor ok: ${items.length} rows, parsed ${parsed}, posts with text ${after}/${posts.length}`)
  } catch (err) {
    apifyLog('error', platform, `comments actor failed: ${err.message}`)
  }
}

// Public-data engagement rate: interactions ÷ followers. This is the only
// engagement definition computable without owner analytics, and it is the
// same formula on every platform here — so unlike the previous per-platform
// definitions, these numbers ARE comparable across channels.
export function engagementRate(posts, followers) {
  if (!followers || !posts?.length) return null
  const totals = posts.reduce((a, p) => a + (p.likes || 0) + (p.comments || 0) + (p.shares || 0), 0)
  const perPost = totals / posts.length
  return Number(((perPost / followers) * 100).toFixed(2))
}

// ─── Public entry point ─────────────────────────────────────────────────────
/**
 * Scrape one platform for one handle.
 * Resolves to { account, posts } — never throws for a single missing field,
 * but does throw ApifyError when the run itself fails so the caller can
 * report per-platform status honestly.
 */
export async function fetchPlatform(platform, rawHandle, { postLimit = MAX_POSTS } = {}) {
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    apifyLog('error', platform, `unsupported platform, rawHandle=${JSON.stringify(rawHandle)}`)
    throw new ApifyError(`No Apify source configured for "${platform}".`, { status: 400, platform })
  }
  const handle = bareHandle(rawHandle, platform)
  if (!handle) {
    apifyLog('error', platform, `empty handle after normalize, raw=${JSON.stringify(rawHandle)}`)
    throw new ApifyError(`No handle set for ${platform}.`, { status: 400, platform })
  }
  apifyLog('log', platform, `fetch start handle=@${handle}`)

  // Clamped, not trusted: MAX_POSTS is the ceiling whatever the caller asks for.
  const limit = Math.max(1, Math.min(MAX_POSTS, Number(postLimit) || MAX_POSTS))

  // Substack's posts actor already returns the publication's name, subscriber
  // count and avatar on every row, so running a second actor would scrape the
  // same page twice and bill for it. The account is derived from a post below.
  const profileOnly = PROFILE_OPTIONAL.has(platform)

  const [profileItems, postItems] = await Promise.all([
    profileOnly
      ? Promise.resolve([])
      : runActor(ACTORS[`${platform}_profile`], PROFILE_INPUT[platform](handle), { platform }),
    runActor(ACTORS[`${platform}_posts`], POSTS_INPUT[platform](handle, limit), { platform }),
  ])

  // clockworks (and some others) push an {errorCode} row instead of skipping
  // a private/missing profile. Those are not posts — drop them before
  // normalize or a channel can look empty for the wrong reason.
  const errorItems = postItems.filter((p) => p?.errorCode)
  const usableItems = postItems.filter((p) => p && !p.errorCode)
  if (errorItems.length) {
    apifyLog('warn', platform, `${errorItems.length} error item(s) from actor`, errorItems.map((e) => ({
      errorCode: e.errorCode, error: e.error, input: e.input, url: e.url,
    })))
  }
  apifyLog('log', platform, `raw results: posts=${postItems.length} usable=${usableItems.length} profile=${profileItems.length}`)

  const account = normalizeAccount(platform, profileItems[0] || (profileOnly ? usableItems[0] : null), handle)
  const posts = usableItems.map((p) => normalizePost(platform, p)).filter((p) => p && (p.publishedAt || p.url))
  const dropped = usableItems.length - posts.length
  if (dropped > 0) {
    apifyLog('warn', platform, `dropped ${dropped} item(s) with no date and no url`)
  }

  // Some post actors also carry author follower counts; use as a fallback so
  // engagement rate still works when the profile actor returns nothing usable.
  if (account && account.followers == null && usableItems.length) {
    account.followers = num(pick(usableItems[0], [
      'author.followers', 'author.follower_count', 'authorFollowers', 'ownerFollowersCount',
      'authorMeta.fans', 'authorMeta.followers',
    ]))
  }

  posts.sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))

  // A run that returns nothing usable is a FAILURE, not an empty success.
  // Actors are happy to scrape the wrong page — a platform homepage, a private
  // account, a renamed handle — and exit cleanly with zero rows. Reported as
  // ok:true that shows up as a connected channel with no data and no reason,
  // which is exactly how a mistyped Substack handle stayed invisible.
  if (!posts.length && account?.followers == null) {
    apifyLog('error', platform, `no posts and no followers for @${handle}`)
    throw new ApifyError(
      `${platform}: the scrape ran but returned no posts and no profile for "${handle}". `
      + 'Check the handle under Profile → Channels — the account may be private, renamed, or empty.',
      { status: 404, platform, actor: ACTORS[`${platform}_posts`] },
    )
  }

  // Some actors ignore their own results limit and overshoot; enforce it here
  // so the cap holds regardless of which actor is configured.
  const capped = posts.slice(0, limit)

  // Comment text is fetched against the capped set only — otherwise a noisy
  // actor that overshoots would bill a comments run for posts we throw away.
  await attachComments(platform, capped, usableItems)

  const rate = engagementRate(capped, account?.followers)
  apifyLog('log', platform, `fetch ok @${handle}`, {
    followers: account?.followers ?? null,
    posts: capped.length,
    commentsWithText: capped.filter((p) => p.commentThread?.length).length,
    engagementRate: rate,
  })

  return {
    account,
    posts: capped,
    engagementRate: rate,
  }
}

export const APIFY_ACTORS = ACTORS
