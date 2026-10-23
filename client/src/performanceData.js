// =============================================================================
// performanceData.js — Mock performance data for all five platforms.
//
// Structure mirrors real API response shapes so swapping to live data later
// is a straightforward replacement of these exports:
//
//   PLATFORM_METRICS → account-level aggregates
//     Instagram  : Graph API  GET /v19.0/{ig-user-id}/insights + /media
//     LinkedIn   : Marketing API  /organizationalEntityFollowerStatistics
//     X (Twitter): API v2  GET /2/users/:id  (public_metrics snapshot only —
//                  no historical follower endpoint exists on X API v2)
//     Substack   : Publisher API  GET /publication/stats
//
//   PLATFORM_POSTS → post-level drill-down
//     Instagram  : GET /v19.0/{media-id}/insights
//     LinkedIn   : GET /v2/socialActions/{shareUrn}/statistics (content analytics)
//     X          : API v2 tweet.fields=public_metrics
//     Substack   : GET /publication/posts/{slug}/stats
// =============================================================================

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function spark(base, len = 16, variance = 0.25) {
  return Array.from({ length: len }, (_, i) => {
    const trend = base * (0.7 + (i / (len - 1)) * 0.6)
    const noise = (Math.random() - 0.5) * base * variance
    return Math.round(Math.max(0, trend + noise))
  })
}

// ---------------------------------------------------------------------------
// PLATFORM_METRICS
// Account-level aggregates, keyed by period ('7d' | '30d' | '90d').
// ---------------------------------------------------------------------------
export const PLATFORM_METRICS = {


  // ─── Instagram ────────────────────────────────────────────────────────────
  // Graph API fields: reach, impressions, profile_views, follower_count,
  //   media insights: engagement (likes+comments), impressions, reach, saved
  // Note: saves, shares are private metrics — only available for connected
  //   account, not competitor data.
  // Note: demographic/follower breakdowns unavailable under 100 followers.
  instagram: {
    connected: true,
    label: 'Instagram',
    dot: 'p-instagram',
    category: 'social',
    sampleSize: 2840, // follower count — above 100 threshold
    metrics: {
      '7d': [
        { key: 'reach',         label: 'Reach',          value: 8200,  delta: +6.1, sparkline: spark(8200) },
        { key: 'impressions',   label: 'Impressions',    value: 19400, delta: +4.8, sparkline: spark(19400),
          note: 'Instagram impressions count every view, including repeat views.' },
        { key: 'profile_views', label: 'Profile Views',  value: 640,   delta: +9.2, sparkline: spark(640) },
        { key: 'followers',     label: 'Followers',      value: 2840,  delta: +1.4, sparkline: spark(2840, 8, 0.05) },
        { key: 'engagement',    label: 'Engagement',     value: 412,   delta: +7.3, sparkline: spark(412) },
        { key: 'saves',         label: 'Saves',          value: 186,   delta: +12.4, sparkline: spark(186), private: true },
      ],
      '30d': [
        { key: 'reach',         label: 'Reach',          value: 31200,  delta: +8.4,  sparkline: spark(31200) },
        { key: 'impressions',   label: 'Impressions',    value: 74800,  delta: +6.2,  sparkline: spark(74800), note: 'Instagram impressions count every view including repeat views.' },
        { key: 'profile_views', label: 'Profile Views',  value: 2480,   delta: +11.8, sparkline: spark(2480) },
        { key: 'followers',     label: 'Followers',      value: 2840,   delta: +5.6,  sparkline: spark(2840, 8, 0.04) },
        { key: 'engagement',    label: 'Engagement',     value: 1640,   delta: +9.7,  sparkline: spark(1640) },
        { key: 'saves',         label: 'Saves',          value: 724,    delta: +15.2, sparkline: spark(724), private: true },
      ],
      '90d': [
        { key: 'reach',         label: 'Reach',          value: 92400,  delta: +18.0, sparkline: spark(92400) },
        { key: 'impressions',   label: 'Impressions',    value: 222000, delta: +14.4, sparkline: spark(222000), note: 'Instagram impressions count every view including repeat views.' },
        { key: 'profile_views', label: 'Profile Views',  value: 7440,   delta: +20.1, sparkline: spark(7440) },
        { key: 'followers',     label: 'Followers',      value: 2840,   delta: +18.3, sparkline: spark(2840, 8, 0.03) },
        { key: 'engagement',    label: 'Engagement',     value: 4920,   delta: +22.6, sparkline: spark(4920) },
        { key: 'saves',         label: 'Saves',          value: 2172,   delta: +26.8, sparkline: spark(2172), private: true },
      ],
    },
  },

  // ─── LinkedIn ─────────────────────────────────────────────────────────────
  // Marketing API fields: organicFollowerCount, paidFollowerCount,
  //   followerGainsByAssociationType, impressions, reach, reactions,
  //   comments, reposts, clicks, engagement rate
  linkedin: {
    connected: true,
    label: 'LinkedIn',
    dot: 'p-linkedin',
    category: 'social',
    metrics: {
      '7d': [
        { key: 'organic_followers', label: 'Organic Followers', value: 3420,  delta: +2.8,  sparkline: spark(3420, 8, 0.04) },
        { key: 'paid_followers',    label: 'Paid Followers',    value: 140,   delta: +0.0,  sparkline: spark(140, 8, 0.02) },
        { key: 'impressions',       label: 'Impressions',       value: 22800, delta: +5.4,  sparkline: spark(22800) },
        { key: 'reach',             label: 'Reach',             value: 11400, delta: +4.1,  sparkline: spark(11400) },
        { key: 'reactions',         label: 'Reactions',         value: 284,   delta: +6.9,  sparkline: spark(284) },
        { key: 'comments',          label: 'Comments',          value: 46,    delta: +14.2, sparkline: spark(46) },
        { key: 'reposts',           label: 'Reposts',           value: 18,    delta: +2.0,  sparkline: spark(18) },
        { key: 'clicks',            label: 'Clicks',            value: 320,   delta: +9.8,  sparkline: spark(320) },
        { key: 'engagement_rate',   label: 'Engagement Rate',   value: 2.88,  delta: +0.3,  sparkline: spark(2.88, 8, 0.15), format: 'pct' },
      ],
      '30d': [
        { key: 'organic_followers', label: 'Organic Followers', value: 3420,  delta: +10.4, sparkline: spark(3420, 8, 0.04) },
        { key: 'paid_followers',    label: 'Paid Followers',    value: 140,   delta: +0.0,  sparkline: spark(140, 8, 0.02) },
        { key: 'impressions',       label: 'Impressions',       value: 88400, delta: +12.1, sparkline: spark(88400) },
        { key: 'reach',             label: 'Reach',             value: 44200, delta: +9.6,  sparkline: spark(44200) },
        { key: 'reactions',         label: 'Reactions',         value: 1120,  delta: +8.4,  sparkline: spark(1120) },
        { key: 'comments',          label: 'Comments',          value: 184,   delta: +18.0, sparkline: spark(184) },
        { key: 'reposts',           label: 'Reposts',           value: 72,    delta: +4.5,  sparkline: spark(72) },
        { key: 'clicks',            label: 'Clicks',            value: 1280,  delta: +13.2, sparkline: spark(1280) },
        { key: 'engagement_rate',   label: 'Engagement Rate',   value: 2.94,  delta: +0.5,  sparkline: spark(2.94, 8, 0.12), format: 'pct' },
      ],
      '90d': [
        { key: 'organic_followers', label: 'Organic Followers', value: 3420,  delta: +24.0, sparkline: spark(3420, 8, 0.04) },
        { key: 'paid_followers',    label: 'Paid Followers',    value: 140,   delta: +0.0,  sparkline: spark(140, 8, 0.02) },
        { key: 'impressions',       label: 'Impressions',       value: 264000, delta: +28.3, sparkline: spark(264000) },
        { key: 'reach',             label: 'Reach',             value: 132000, delta: +22.1, sparkline: spark(132000) },
        { key: 'reactions',         label: 'Reactions',         value: 3360,  delta: +19.2, sparkline: spark(3360) },
        { key: 'comments',          label: 'Comments',          value: 552,   delta: +26.4, sparkline: spark(552) },
        { key: 'reposts',           label: 'Reposts',           value: 216,   delta: +11.8, sparkline: spark(216) },
        { key: 'clicks',            label: 'Clicks',            value: 3840,  delta: +18.6, sparkline: spark(3840) },
        { key: 'engagement_rate',   label: 'Engagement Rate',   value: 3.08,  delta: +0.8,  sparkline: spark(3.08, 8, 0.10), format: 'pct' },
      ],
    },
  },

  // ─── X (Twitter) ──────────────────────────────────────────────────────────
  // API v2 user.public_metrics: followers_count, following_count,
  //   tweet_count, listed_count
  // Note: X provides NO historical follower-count endpoint. Follower growth
  //   here is based on periodic manual snapshots, not a live trend line.
  //   The sparkline uses type:'snapshot' — the UI renders bar ticks, not
  //   a smooth line, and shows the disclaimer copy.
  x: {
    connected: true,
    label: 'X',
    dot: 'p-x',
    category: 'social',
    followerGrowthType: 'snapshot', // triggers UI disclaimer
    metrics: {
      '7d': [
        { key: 'followers',       label: 'Followers',       value: 1840,  delta: +0.8,  sparkline: spark(1840, 8, 0.01), snapshotOnly: true },
        { key: 'impressions',     label: 'Impressions',     value: 14200, delta: +3.6,  sparkline: spark(14200),
          note: 'X impressions = total times tweets were seen in timelines/search. Not comparable to Instagram impressions.' },
        { key: 'likes',           label: 'Likes',           value: 186,   delta: +4.2,  sparkline: spark(186) },
        { key: 'retweets',        label: 'Retweets',        value: 32,    delta: +2.1,  sparkline: spark(32) },
        { key: 'replies',         label: 'Replies',         value: 24,    delta: +8.8,  sparkline: spark(24) },
        { key: 'bookmarks',       label: 'Bookmarks',       value: 58,    delta: +11.2, sparkline: spark(58) },
        { key: 'engagement_rate', label: 'Engagement Rate', value: 1.62,  delta: +0.2,  sparkline: spark(1.62, 8, 0.12), format: 'pct',
          note: 'X engagement rate = (likes + retweets + replies + quotes) ÷ impressions.' },
      ],
      '30d': [
        { key: 'followers',       label: 'Followers',       value: 1840,  delta: +3.2,  sparkline: spark(1840, 8, 0.01), snapshotOnly: true },
        { key: 'impressions',     label: 'Impressions',     value: 54800, delta: +7.2,  sparkline: spark(54800), note: 'X impressions = total times tweets were seen.' },
        { key: 'likes',           label: 'Likes',           value: 724,   delta: +5.8,  sparkline: spark(724) },
        { key: 'retweets',        label: 'Retweets',        value: 128,   delta: +3.4,  sparkline: spark(128) },
        { key: 'replies',         label: 'Replies',         value: 96,    delta: +10.1, sparkline: spark(96) },
        { key: 'bookmarks',       label: 'Bookmarks',       value: 228,   delta: +13.6, sparkline: spark(228) },
        { key: 'engagement_rate', label: 'Engagement Rate', value: 1.74,  delta: +0.4,  sparkline: spark(1.74, 8, 0.10), format: 'pct', note: 'X engagement rate = (likes + retweets + replies + quotes) ÷ impressions.' },
      ],
      '90d': [
        { key: 'followers',       label: 'Followers',       value: 1840,  delta: +8.4,  sparkline: spark(1840, 8, 0.01), snapshotOnly: true },
        { key: 'impressions',     label: 'Impressions',     value: 164000, delta: +18.6, sparkline: spark(164000), note: 'X impressions = total times tweets were seen.' },
        { key: 'likes',           label: 'Likes',           value: 2172,  delta: +14.2, sparkline: spark(2172) },
        { key: 'retweets',        label: 'Retweets',        value: 384,   delta: +9.8,  sparkline: spark(384) },
        { key: 'replies',         label: 'Replies',         value: 288,   delta: +16.4, sparkline: spark(288) },
        { key: 'bookmarks',       label: 'Bookmarks',       value: 684,   delta: +22.0, sparkline: spark(684) },
        { key: 'engagement_rate', label: 'Engagement Rate', value: 1.86,  delta: +0.7,  sparkline: spark(1.86, 8, 0.08), format: 'pct', note: 'X engagement rate = (likes + retweets + replies + quotes) ÷ impressions.' },
      ],
    },
  },

  // ─── Substack ─────────────────────────────────────────────────────────────
  // Publisher API fields: total_subscribers, paid_subscribers,
  //   gross_annualized_revenue, views, open_rate, email_deliveries,
  //   email_opens, likes, comments, shares, subscriber_conversions
  // Note: Substack metrics are publication-wide (newsletter performance),
  //   not per-social-post. Framed as "Newsletter Performance" in the UI.
  substack: {
    connected: true,
    label: 'Substack',
    dot: 'p-substack',
    category: 'newsletter', // UI renders "Newsletter Performance" heading
    metrics: {
      '7d': [
        { key: 'total_subscribers',  label: 'Total Subscribers',  value: 2140,  delta: +1.8,  sparkline: spark(2140, 8, 0.03) },
        { key: 'paid_subscribers',   label: 'Paid Subscribers',   value: 186,   delta: +3.2,  sparkline: spark(186, 8, 0.04) },
        { key: 'open_rate',          label: 'Open Rate',          value: 54.7,  delta: +2.1,  sparkline: spark(54.7, 8, 0.08), format: 'pct' },
        { key: 'email_deliveries',   label: 'Email Deliveries',   value: 2060,  delta: +0.4,  sparkline: spark(2060, 8, 0.02) },
        { key: 'email_opens',        label: 'Email Opens',        value: 1148,  delta: +3.6,  sparkline: spark(1148) },
        { key: 'likes',              label: 'Likes',              value: 62,    delta: +8.6,  sparkline: spark(62) },
        { key: 'comments',           label: 'Comments',           value: 11,    delta: +10.0, sparkline: spark(11) },
        { key: 'shares',             label: 'Shares',             value: 28,    delta: +5.4,  sparkline: spark(28) },
      ],
      '30d': [
        { key: 'total_subscribers',  label: 'Total Subscribers',  value: 2140,  delta: +6.8,  sparkline: spark(2140, 8, 0.03) },
        { key: 'paid_subscribers',   label: 'Paid Subscribers',   value: 186,   delta: +12.0, sparkline: spark(186, 8, 0.04) },
        { key: 'open_rate',          label: 'Open Rate',          value: 54.7,  delta: +4.2,  sparkline: spark(54.7, 8, 0.06), format: 'pct' },
        { key: 'email_deliveries',   label: 'Email Deliveries',   value: 8240,  delta: +1.6,  sparkline: spark(8240, 8, 0.02) },
        { key: 'email_opens',        label: 'Email Opens',        value: 4590,  delta: +6.1,  sparkline: spark(4590) },
        { key: 'likes',              label: 'Likes',              value: 248,   delta: +11.4, sparkline: spark(248) },
        { key: 'comments',           label: 'Comments',           value: 44,    delta: +14.3, sparkline: spark(44) },
        { key: 'shares',             label: 'Shares',             value: 112,   delta: +8.8,  sparkline: spark(112) },
      ],
      '90d': [
        { key: 'total_subscribers',  label: 'Total Subscribers',  value: 2140,  delta: +18.6, sparkline: spark(2140, 8, 0.03) },
        { key: 'paid_subscribers',   label: 'Paid Subscribers',   value: 186,   delta: +28.0, sparkline: spark(186, 8, 0.04) },
        { key: 'open_rate',          label: 'Open Rate',          value: 54.7,  delta: +6.8,  sparkline: spark(54.7, 8, 0.05), format: 'pct' },
        { key: 'email_deliveries',   label: 'Email Deliveries',   value: 24720, delta: +4.2,  sparkline: spark(24720, 8, 0.02) },
        { key: 'email_opens',        label: 'Email Opens',        value: 13770, delta: +9.4,  sparkline: spark(13770) },
        { key: 'likes',              label: 'Likes',              value: 744,   delta: +16.8, sparkline: spark(744) },
        { key: 'comments',           label: 'Comments',           value: 132,   delta: +20.0, sparkline: spark(132) },
        { key: 'shares',             label: 'Shares',             value: 336,   delta: +12.2, sparkline: spark(336) },
      ],
    },
  },
}

// Engagement rate per platform, used for the cross-platform comparison chart
// and the Overview teaser. Normalized to a comparable % value per platform.
// Definitions differ — see tooltips in the UI.
export const ENGAGEMENT_RATES = {
  instagram: { value: 5.0,  delta: +0.7, label: 'Likes + Comments ÷ Reach' },
  linkedin:  { value: 2.9,  delta: +0.3, label: 'Engagements ÷ Impressions' },
  x:         { value: 1.6,  delta: +0.2, label: '(Likes + RT + Replies) ÷ Impressions' },
  substack:  { value: 54.7, delta: +2.1, label: 'Open Rate' },
}

// ---------------------------------------------------------------------------
// PLATFORM_POSTS
// Post-level drill-down, one array per platform.
// thumbUrl: null = use platform-color swatch fallback (no broken img).
// metrics.available: false = show "—" chip, never a zero.
// ---------------------------------------------------------------------------
export const PLATFORM_POSTS = {


  instagram: [
    {
      id: 'ig-1', platform: 'instagram', publishedAt: '2026-07-25',
      title: 'Stop waiting for the perfect moment ✨',
      thumbUrl: null,
      metrics: {
        views: 4100, reach: 2900, likes: 210, comments: 28,
        saves: { value: 74, private: true },
        shares: { value: 18, private: true },
      },
    },
    {
      id: 'ig-2', platform: 'instagram', publishedAt: '2026-07-19',
      title: 'The three-hour content batch that changed my week',
      thumbUrl: null,
      metrics: {
        views: 6200, reach: 4400, likes: 316, comments: 44,
        saves: { value: 128, private: true },
        shares: { value: 32, private: true },
      },
    },
    {
      id: 'ig-3', platform: 'instagram', publishedAt: '2026-07-14',
      title: 'Carousel: 5 signs your content strategy is actually working',
      thumbUrl: null,
      metrics: {
        views: 9800, reach: 7200, likes: 488, comments: 62,
        saves: { value: 214, private: true },
        shares: { value: 56, private: true },
      },
    },
    {
      id: 'ig-4', platform: 'instagram', publishedAt: '2026-07-07',
      title: 'Reel: Behind the scenes of a monthly content planning session',
      thumbUrl: null,
      isReel: true,
      metrics: {
        views: 14200, reach: 11000, likes: 724, comments: 88,
        saves: { value: 342, private: true },
        shares: { value: 98, private: true },
        skip_rate: { value: 28.4, format: 'pct', available: true },
      },
    },
    {
      id: 'ig-5', platform: 'instagram', publishedAt: '2026-06-30',
      title: 'Minimalist workspace layout & productivity essentials',
      thumbUrl: null,
      metrics: {
        views: 5400, reach: 3900, likes: 284, comments: 36,
        saves: { value: 112, private: true },
        shares: { value: 24, private: true },
      },
    },
    {
      id: 'ig-6', platform: 'instagram', publishedAt: '2026-06-22',
      title: 'Carousel: How we structure client content calendar boards',
      thumbUrl: null,
      metrics: {
        views: 8600, reach: 6400, likes: 412, comments: 52,
        saves: { value: 194, private: true },
        shares: { value: 48, private: true },
      },
    },
    {
      id: 'ig-7', platform: 'instagram', publishedAt: '2026-06-16',
      title: 'Reel: 3 quick editing tricks for video carousels',
      thumbUrl: null,
      isReel: true,
      metrics: {
        views: 11800, reach: 9100, likes: 620, comments: 74,
        saves: { value: 298, private: true },
        shares: { value: 82, private: true },
        skip_rate: { value: 24.1, format: 'pct', available: true },
      },
    },
    {
      id: 'ig-8', platform: 'instagram', publishedAt: '2026-06-09',
      title: 'Quotes that kept us grounded this month',
      thumbUrl: null,
      metrics: {
        views: 4800, reach: 3400, likes: 240, comments: 29,
        saves: { value: 88, private: true },
        shares: { value: 20, private: true },
      },
    },
  ],

  linkedin: [
    {
      id: 'li-1', platform: 'linkedin', publishedAt: '2026-07-23',
      title: 'Authentic content in the age of AI: what actually resonates',
      thumbUrl: null,
      metrics: {
        impressions: 4800, reach: 2400, reactions: 92,
        comments: 18, reposts: 7, clicks: 140, engagement_rate: 3.12,
      },
    },
    {
      id: 'li-2', platform: 'linkedin', publishedAt: '2026-07-16',
      title: 'Three content pillars that keep my posting consistent (without burnout)',
      thumbUrl: null,
      metrics: {
        impressions: 7200, reach: 3600, reactions: 144,
        comments: 26, reposts: 11, clicks: 220, engagement_rate: 3.64,
      },
    },
    {
      id: 'li-3', platform: 'linkedin', publishedAt: '2026-07-09',
      title: 'From conference talk to LinkedIn article in 4 steps',
      thumbUrl: null,
      metrics: {
        impressions: 11400, reach: 5700, reactions: 228,
        comments: 42, reposts: 18, clicks: 340, engagement_rate: 4.28,
      },
    },
    {
      id: 'li-4', platform: 'linkedin', publishedAt: '2026-07-02',
      title: 'The \"better feedback loop\" that made me a better writer',
      thumbUrl: null,
      metrics: {
        impressions: 6600, reach: 3300, reactions: 118,
        comments: 24, reposts: 9, clicks: 192, engagement_rate: 3.38,
      },
    },
    {
      id: 'li-5', platform: 'linkedin', publishedAt: '2026-06-25',
      title: 'Why standard vanity metrics misguide B2B content teams',
      thumbUrl: null,
      metrics: {
        impressions: 8900, reach: 4450, reactions: 182,
        comments: 34, reposts: 14, clicks: 270, engagement_rate: 3.92,
      },
    },
    {
      id: 'li-6', platform: 'linkedin', publishedAt: '2026-06-18',
      title: 'Building a scalable content engine for small agencies',
      thumbUrl: null,
      metrics: {
        impressions: 9800, reach: 4900, reactions: 204,
        comments: 38, reposts: 16, clicks: 295, engagement_rate: 4.05,
      },
    },
    {
      id: 'li-7', platform: 'linkedin', publishedAt: '2026-06-11',
      title: 'How we manage 10+ active social channels without dropping quality',
      thumbUrl: null,
      metrics: {
        impressions: 12600, reach: 6300, reactions: 268,
        comments: 49, reposts: 22, clicks: 380, engagement_rate: 4.42,
      },
    },
    {
      id: 'li-8', platform: 'linkedin', publishedAt: '2026-06-04',
      title: 'The exact framework we use to review post copy before publishing',
      thumbUrl: null,
      metrics: {
        impressions: 5400, reach: 2700, reactions: 106,
        comments: 21, reposts: 8, clicks: 160, engagement_rate: 3.24,
      },
    },
  ],

  x: [
    {
      id: 'x-1', platform: 'x', publishedAt: '2026-07-26',
      title: 'Most people overcomplicate content. The fix isn\'t more effort.',
      thumbUrl: null,
      metrics: {
        impressions: 2840, likes: 48, retweets: 12, replies: 8, quotes: 3, bookmarks: 22,
        engagement_rate: 3.20,
      },
    },
    {
      id: 'x-2', platform: 'x', publishedAt: '2026-07-20',
      title: 'Thread: Capture → repurpose → schedule. The whole loop in 5 tweets.',
      thumbUrl: null,
      isThread: true,
      metrics: {
        impressions: 5600, likes: 96, retweets: 28, replies: 14, quotes: 6, bookmarks: 44,
        engagement_rate: 3.65,
      },
    },
    {
      id: 'x-3', platform: 'x', publishedAt: '2026-07-13',
      title: 'Authenticity isn\'t a strategy. It\'s what\'s left when the strategy works.',
      thumbUrl: null,
      metrics: {
        impressions: 4200, likes: 72, retweets: 18, replies: 11, quotes: 4, bookmarks: 32,
        engagement_rate: 2.98,
      },
    },
    {
      id: 'x-4', platform: 'x', publishedAt: '2026-07-06',
      title: 'Unpopular opinion: simple text posts beat fancy graphics on X 9/10 times.',
      thumbUrl: null,
      metrics: {
        impressions: 6400, likes: 112, retweets: 32, replies: 16, quotes: 8, bookmarks: 52,
        engagement_rate: 3.75,
      },
    },
    {
      id: 'x-5', platform: 'x', publishedAt: '2026-06-29',
      title: 'The 15-minute daily engagement habit for founders on X.',
      thumbUrl: null,
      metrics: {
        impressions: 3900, likes: 64, retweets: 16, replies: 9, quotes: 4, bookmarks: 28,
        engagement_rate: 3.02,
      },
    },
    {
      id: 'x-6', platform: 'x', publishedAt: '2026-06-21',
      title: 'Thread: 7 hook templates that get people scrolling to stop.',
      thumbUrl: null,
      isThread: true,
      metrics: {
        impressions: 7800, likes: 142, retweets: 41, replies: 21, quotes: 11, bookmarks: 68,
        engagement_rate: 3.91,
      },
    },
    {
      id: 'x-7', platform: 'x', publishedAt: '2026-06-14',
      title: 'Your content system should work even on your worst energy day.',
      thumbUrl: null,
      metrics: {
        impressions: 4900, likes: 84, retweets: 22, replies: 12, quotes: 5, bookmarks: 38,
        engagement_rate: 3.16,
      },
    },
  ],

  substack: [
    {
      id: 'ss-1', platform: 'substack', publishedAt: '2026-07-22',
      title: 'The system problem (not the willpower problem)',
      thumbUrl: null,
      metrics: {
        deliveries: 2060, opens: 1148, open_rate: 55.7,
        link_clicks: 84, likes: 62, comments: 11, shares: 28,
        free_conversions: 6, paid_conversions: 1,
      },
    },
    {
      id: 'ss-2', platform: 'substack', publishedAt: '2026-07-08',
      title: 'Build the thing once, then feed it',
      thumbUrl: null,
      metrics: {
        deliveries: 2020, opens: 1090, open_rate: 53.9,
        link_clicks: 72, likes: 54, comments: 8, shares: 22,
        free_conversions: 4, paid_conversions: 0,
      },
    },
    {
      id: 'ss-3', platform: 'substack', publishedAt: '2026-06-24',
      title: 'What midlife content actually looks like when it\'s working',
      thumbUrl: null,
      metrics: {
        deliveries: 1980, opens: 1092, open_rate: 55.2,
        link_clicks: 96, likes: 78, comments: 14, shares: 36,
        free_conversions: 9, paid_conversions: 2,
      },
    },
    {
      id: 'ss-4', platform: 'substack', publishedAt: '2026-06-10',
      title: 'Designing your weekly newsletter writing ritual',
      thumbUrl: null,
      metrics: {
        deliveries: 1940, opens: 1040, open_rate: 53.6,
        link_clicks: 68, likes: 48, comments: 9, shares: 19,
        free_conversions: 3, paid_conversions: 0,
      },
    },
    {
      id: 'ss-5', platform: 'substack', publishedAt: '2026-05-27',
      title: 'Why long-form newsletters build deeper subscriber trust',
      thumbUrl: null,
      metrics: {
        deliveries: 1900, opens: 1054, open_rate: 55.5,
        link_clicks: 88, likes: 70, comments: 12, shares: 31,
        free_conversions: 7, paid_conversions: 1,
      },
    },
    {
      id: 'ss-6', platform: 'substack', publishedAt: '2026-05-13',
      title: 'The 3 email headers that improved our click-through rates',
      thumbUrl: null,
      metrics: {
        deliveries: 1860, opens: 1012, open_rate: 54.4,
        link_clicks: 78, likes: 58, comments: 10, shares: 24,
        free_conversions: 5, paid_conversions: 1,
      },
    },
  ],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Default sort metric per platform for the top-posts table
export const DEFAULT_SORT = {
  all:       { key: 'engagement_rate_derived', label: 'Eng. Rate' },
  instagram: { key: 'saves_value',   label: 'Saves' },
  linkedin:  { key: 'engagement_rate', label: 'Eng. Rate' },
  x:         { key: 'impressions',   label: 'Impressions' },
  substack:  { key: 'open_rate',     label: 'Open Rate' },
}

// Primary + secondary metric columns per platform
export const COLUMNS = {
  all:       [{ key: 'engagement_rate_derived', label: 'Eng. Rate', format: 'pct' }, { key: 'impressions_derived', label: 'Impressions' }],
  instagram: [{ key: 'saves_value', label: 'Saves', private: true }, { key: 'reach', label: 'Reach' }],
  linkedin:  [{ key: 'engagement_rate', label: 'Eng. Rate', format: 'pct' }, { key: 'impressions', label: 'Impressions' }],
  x:         [{ key: 'impressions', label: 'Impressions' }, { key: 'engagement_rate', label: 'Eng. Rate', format: 'pct' }],
  substack:  [{ key: 'open_rate', label: 'Open Rate', format: 'pct' }, { key: 'free_conversions', label: 'Free Conv.' }],
}

// Derive a flat value from a post for sorting
export function getSortValue(post, key) {
  const m = post.metrics
  switch (key) {
    case 'reach':                return m.reach ?? m.views ?? 0
    case 'reactions_total':      return m.reactions?.total ?? m.reactions ?? 0
    case 'saves_value':          return m.saves?.value ?? m.saves ?? 0
    case 'engagement_rate':      return m.engagement_rate ?? 0
    case 'impressions':          return m.impressions ?? m.views ?? 0
    case 'open_rate':            return m.open_rate ?? 0
    case 'free_conversions':     return m.free_conversions ?? 0
    // 'all' view — derive engagement rate from whatever the platform exposes
    case 'engagement_rate_derived': {
      if (m.engagement_rate != null) return m.engagement_rate
      if (m.open_rate != null) return m.open_rate
      const eng = (m.reactions?.total ?? 0) + (m.likes ?? 0) + (m.comments ?? 0)
      const base = m.reach ?? m.impressions ?? 1
      return (eng / base) * 100
    }
    case 'impressions_derived':  return m.impressions ?? m.views ?? m.reach ?? 0
    default:                     return 0
  }
}

// Format a metric value for display
export function fmtMetric(value, format) {
  if (value == null) return '—'
  if (format === 'pct') return `${Number(value).toFixed(1)}%`
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return String(value)
}

// All posts in a flat list, for the "All" channel view
export function allPosts() {
  return Object.values(PLATFORM_POSTS).flat()
}
