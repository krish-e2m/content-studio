// ---------------------------------------------------------------------------
// performanceLive.js
// Shapes the server's Apify payload into what the Performance UI renders.
//
// The metric set here is deliberately narrow: it contains only what public
// scraping can actually observe. Reach, impressions, saves, profile views and
// email open rate are absent because Apify cannot see them — they exist only
// behind an owner-authenticated platform API. Nothing here is derived from a
// number the scraper didn't return.
// ---------------------------------------------------------------------------

export const PLATFORM_COLORS = {
  instagram: '#c1558b', linkedin: '#2f6f9f', x: '#2b2b2b', substack: '#cf6b4a',
  tiktok: '#fe2c55',
}

export const PLATFORM_LABELS = {
  instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X', substack: 'Substack',
  tiktok: 'TikTok',
}

// Substack counts subscribers, not followers. Same number, different word —
// and a metric reads as wrong when it uses a term the platform itself never
// does. Per-channel views use the platform's own noun; cross-channel totals
// stay on "Followers", since one label has to cover a mix of both.
const FOLLOWER_NOUN = { substack: 'Subscribers' }
export const followerLabel = (platform) => FOLLOWER_NOUN[platform] || 'Followers'
export const followerWord = (platform) => followerLabel(platform).toLowerCase()

// Order is fixed so a channel keeps its identity when others come and go.
export const PLATFORM_ORDER = ['instagram', 'linkedin', 'x', 'substack', 'tiktok']

// Whether a platform publicly exposes view counts at all. Where it doesn't,
// the column is omitted rather than shown as zero.
const HAS_VIEWS = { instagram: true, linkedin: false, x: true, substack: false, tiktok: true }

export function fmtNum(v) {
  if (v == null || Number.isNaN(v)) return '—'
  const n = Number(v)
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

export function fmtPct(v) {
  return v == null || Number.isNaN(v) ? '—' : `${Number(v).toFixed(2)}%`
}

export function fmtMetric(v, format) {
  return format === 'pct' ? fmtPct(v) : fmtNum(v)
}

// null means "this platform doesn't publish the number"; 0 means "nobody
// engaged". Collapsing the first into the second is a lie the UI can't walk
// back — Instagram exposes no share count at all, and `(p.shares || 0)` turned
// ten nulls into a confident "Shares 0". Only count posts that actually carry
// the field, and report nothing when none of them do.
function values(posts, key) {
  return (posts || []).map((p) => p[key]).filter((v) => typeof v === 'number' && Number.isFinite(v))
}

function sum(posts, key) {
  const v = values(posts, key)
  return v.length ? v.reduce((a, n) => a + n, 0) : null
}

// Averaged over the posts that HAVE the value, not over every post — otherwise
// a partially-reported metric reads lower than it is.
function avg(posts, key) {
  const v = values(posts, key)
  return v.length ? v.reduce((a, n) => a + n, 0) / v.length : null
}

/**
 * Per-platform metric tabs, built strictly from scraped fields.
 * `history` supplies the sparkline: it's the series of past refreshes, so it
 * is empty until a channel has been refreshed more than once.
 */
export function buildMetrics(platform, channel, history = []) {
  if (!channel?.account) return []
  const posts = channel.posts || []
  const acct = channel.account

  const seriesOf = (key) => history.map((h) => h[key]).filter((v) => typeof v === 'number')

  const metrics = [
    {
      key: 'followers',
      label: followerLabel(platform),
      value: acct.followers,
      sparkline: seriesOf('followers'),
      note: `Public ${followerWord(platform).replace(/s$/, '')} count at the time of each refresh.`,
    },
    {
      key: 'engagement_rate',
      label: 'Eng. Rate',
      value: channel.engagementRate,
      format: 'pct',
      sparkline: seriesOf('engagementRate'),
      note: '(Likes + Comments + Shares) ÷ Followers, averaged per post. Same formula on every channel, so these are comparable.',
    },
    {
      key: 'likes',
      label: 'Likes',
      value: sum(posts, 'likes'),
      sparkline: seriesOf('likes'),
      note: `Total across the ${posts.length} most recent posts.`,
    },
    {
      key: 'comments',
      label: 'Comments',
      value: sum(posts, 'comments'),
      sparkline: seriesOf('comments'),
      note: `Total across the ${posts.length} most recent posts.`,
    },
    {
      key: 'shares',
      label: platform === 'x' ? 'Reposts' : 'Shares',
      value: sum(posts, 'shares'),
      sparkline: seriesOf('shares'),
      note: `Total across the ${posts.length} most recent posts.`,
    },
    {
      key: 'avg_likes',
      label: 'Avg. Likes / Post',
      value: avg(posts, 'likes') == null ? null : Math.round(avg(posts, 'likes')),
      sparkline: [],
    },
  ]

  if (HAS_VIEWS[platform]) {
    metrics.splice(5, 0, {
      key: 'views',
      label: 'Views',
      value: sum(posts, 'views'),
      sparkline: seriesOf('views'),
      note: 'Only counted for posts where the platform displays views publicly.',
    })
  }

  // Compute period-over-period delta from the snapshot series where we have
  // two or more readings; otherwise leave it off rather than invent a change.
  return metrics.map((m) => {
    const s = m.sparkline || []
    if (s.length < 2) return { ...m, delta: null }
    const first = s[0], last = s[s.length - 1]
    if (!first) return { ...m, delta: null }
    const delta = m.format === 'pct' ? last - first : ((last - first) / first) * 100
    return { ...m, delta: Number(delta.toFixed(1)) }
  }).filter((m) => m.value != null)
}

/** Summary tiles for one platform. */
export function buildPlatformSummary(platform, channel) {
  if (!channel?.account) return null
  const posts = channel.posts || []
  const acct = channel.account
  const interactions = (sum(posts, 'likes') || 0) + (sum(posts, 'comments') || 0) + (sum(posts, 'shares') || 0)

  // A tile is omitted, not em-dashed, when the figure doesn't exist. Substack
  // publications mostly hide their subscriber count, and with no denominator
  // there is no engagement rate either — two tiles reading "—" said less than
  // no tiles, and implied the number was merely missing rather than unpublished.
  return [
    acct.followers != null && { label: followerLabel(platform), value: fmtNum(acct.followers) },
    channel.engagementRate != null && {
      label: 'Engagement rate',
      value: fmtPct(channel.engagementRate),
      note: `interactions ÷ ${followerWord(platform)}`,
    },
    { label: 'Posts analysed', value: String(posts.length), note: 'most recent public posts' },
    {
      label: 'Avg. interactions',
      value: fmtNum(posts.length ? interactions / posts.length : null),
      note: 'per post',
    },
  ].filter(Boolean)
}

/** Summary tiles for the cross-channel view. */
export function buildAllSummary(channels) {
  const live = PLATFORM_ORDER.map((p) => channels?.[p]).filter((c) => c?.account)
  if (!live.length) return null

  const totalFollowers = live.reduce((a, c) => a + (c.account.followers || 0), 0)
  const totalPosts = live.reduce((a, c) => a + (c.posts?.length || 0), 0)
  const rated = live.filter((c) => c.engagementRate != null)
  const avgRate = rated.length ? rated.reduce((a, c) => a + c.engagementRate, 0) / rated.length : null
  const top = rated.reduce((a, c) => (a == null || c.engagementRate > a.engagementRate ? c : a), null)

  return [
    { label: 'Connected channels', value: String(live.length), note: `of ${PLATFORM_ORDER.length} supported` },
    { label: 'Total followers', value: fmtNum(totalFollowers), note: 'across all channels' },
    { label: 'Avg. engagement rate', value: fmtPct(avgRate), note: 'same formula everywhere' },
    top
      ? { label: 'Top channel', value: PLATFORM_LABELS[top.account.platform] || '—', note: `${fmtPct(top.engagementRate)} eng. rate` }
      : { label: 'Posts analysed', value: String(totalPosts), note: 'most recent public posts' },
  ]
}

/**
 * Cross-channel aggregate metrics. Follower counts and interaction totals sum
 * cleanly across platforms; engagement rate is averaged because it's the same
 * ratio on each channel.
 */
export function buildAllMetrics(channels, history = {}) {
  const live = PLATFORM_ORDER.filter((p) => channels?.[p]?.account)
  if (!live.length) return []

  // Align snapshot series by index across channels — refreshes happen together,
  // so index i is the same refresh on every channel.
  const depth = Math.min(...live.map((p) => (history[p] || []).length))
  const seriesOf = (field) => {
    if (depth < 2) return []
    return Array.from({ length: depth }, (_, i) =>
      live.reduce((a, p) => a + ((history[p][i] || {})[field] || 0), 0))
  }

  const totalOf = (field) => live.reduce((a, p) => {
    const c = channels[p]
    if (field === 'followers') return a + (c.account.followers || 0)
    return a + (c.posts || []).reduce((s, x) => s + (x[field] || 0), 0)
  }, 0)

  const rates = live.map((p) => channels[p].engagementRate).filter((v) => v != null)

  const metrics = [
    { key: 'followers', label: 'Followers', value: totalOf('followers'), sparkline: seriesOf('followers'), note: `Summed across ${live.map((p) => PLATFORM_LABELS[p]).join(', ')}.` },
    { key: 'likes', label: 'Likes', value: totalOf('likes'), sparkline: seriesOf('likes') },
    { key: 'comments', label: 'Comments', value: totalOf('comments'), sparkline: seriesOf('comments') },
    { key: 'shares', label: 'Shares', value: totalOf('shares'), sparkline: seriesOf('shares') },
    {
      key: 'engagement_rate',
      label: 'Eng. Rate',
      value: rates.length ? Number((rates.reduce((a, v) => a + v, 0) / rates.length).toFixed(2)) : null,
      format: 'pct',
      sparkline: [],
      note: 'Mean of each channel’s rate — the same formula on all of them.',
    },
  ]

  return metrics.map((m) => {
    const s = m.sparkline || []
    if (s.length < 2 || !s[0]) return { ...m, delta: null }
    return { ...m, delta: Number((((s[s.length - 1] - s[0]) / s[0]) * 100).toFixed(1)) }
  }).filter((m) => m.value != null)
}

/** Flattens every channel's posts into one list for the "All" view. */
export function allPosts(channels) {
  return PLATFORM_ORDER.flatMap((p) => (channels?.[p]?.posts || []).map((post) => ({ ...post, platform: p })))
}

/** Sort keys offered by the posts "Popular" control, per platform. */
export const POST_SORTS = [
  { key: 'interactions', label: 'Interactions' },
  { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' },
]

export function postSortValue(post, key) {
  if (key === 'interactions') return (post.likes || 0) + (post.comments || 0) + (post.shares || 0)
  return post[key] || 0
}
