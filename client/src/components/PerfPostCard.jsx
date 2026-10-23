import { useState } from 'react'
import { Icon } from '../icons.jsx'
import { mediaSrc } from '../api.js'
import { PLATFORM_COLORS, PLATFORM_LABELS, fmtNum } from '../performanceLive.js'

// Native-looking previews for live scraped posts. Each platform gets the
// chrome a reader would recognise, so a post is identified by what it looks
// like rather than by a coloured dot.
//
// Every figure shown here comes from the scrape. Where a platform doesn't
// publicly expose a number (view counts on LinkedIn, for
// example) the control is simply absent rather than showing a zero.

const fmtDate = (iso, long) => {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(undefined,
      long ? { year: 'numeric', month: 'long', day: 'numeric' } : { month: 'short', day: 'numeric' })
  } catch { return '' }
}

// The two numbers worth putting on the card face, per platform.
const CARD_STATS = {
  instagram: (p) => [{ l: 'Likes', v: p.likes }, { l: 'Comments', v: p.comments }],
  linkedin:  (p) => [{ l: 'Reactions', v: p.likes }, { l: 'Comments', v: p.comments }],
  x:         (p) => [{ l: 'Likes', v: p.likes }, { l: 'Reposts', v: p.shares }],
  substack:  (p) => [{ l: 'Reactions', v: p.likes }, { l: 'Restacks', v: p.shares }],
  tiktok:    (p) => [{ l: 'Views', v: p.views }, { l: 'Likes', v: p.likes }],
}

function Avatar({ client, account, size = 34, ring }) {
  const name = account?.name || client?.name || 'Brand'
  const [failed, setFailed] = useState(false)
  if (account?.avatarUrl && !failed) {
    return (
      <img
        className={`perf-pv-ava img ${ring ? 'ring' : ''}`}
        src={mediaSrc(account.avatarUrl)} alt="" width={size} height={size} loading="lazy"
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <span
      className={`perf-pv-ava ${ring ? 'ring' : ''}`}
      style={{ background: client?.accent || 'var(--rose)', width: size, height: size, fontSize: size * 0.4 }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

// ─── The post body, rendered in platform chrome ─────────────────────────────
export function PostChrome({ post, client, account, full }) {
  const name = account?.name || client?.name || 'Your Brand'
  const handle = account?.handle || (name || 'brand').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const color = PLATFORM_COLORS[post.platform]
  // Mirrored server-side at scrape time, so this is normally our own copy and
  // not the platform's expiring CDN link. A pre-mirror snapshot can still hold
  // a raw CDN url that 403s, so the onError placeholder stays as the backstop.
  const media = mediaSrc(post.thumbUrl)

  const [imgFailed, setImgFailed] = useState(false)
  const showImg = media && !imgFailed

  // Grid cards size naturally in the masonry layout; a short line-clamp keeps
  // very long captions from stretching a tile without fighting image height.
  const bodyClass = `perf-pv-body ${full ? '' : 'clamp'} ${!full && media ? 'tight' : ''}`.trim()

  const Media = () => (
    <div className="perf-pv-media" style={{ background: `linear-gradient(135deg, ${color}22, ${color}0d)` }}>
      {showImg
        ? (
          <>
            <img src={media} alt="" loading="lazy" onError={() => setImgFailed(true)} />
            {post.isVideo && <span className="perf-pv-media-badge"><Icon.Play width={12} height={12} /> Video</span>}
          </>
        )
        : (
          <span className="perf-pv-media-note">
            {imgFailed
              ? 'Image link expired · refresh'
              : post.isVideo ? 'Video' : 'No image'}
          </span>
        )}
    </div>
  )

  if (post.platform === 'tiktok') {
    return (
      <div className="perf-pv perf-pv-tiktok">
        <div className="perf-pv-head ig">
          <Avatar client={client} account={account} size={28} ring />
          <span className="perf-pv-name">@{handle}</span>
        </div>
        <Media />
        <div className="perf-pv-actions x">
          <span><Icon.Heart width={14} height={14} /> {fmtNum(post.likes)}</span>
          <span><Icon.Bubble width={14} height={14} /> {fmtNum(post.comments)}</span>
          <span><Icon.Repost width={14} height={14} /> {fmtNum(post.shares)}</span>
          {post.views != null && <span><Icon.Eye width={14} height={14} /> {fmtNum(post.views)}</span>}
        </div>
        <div className={bodyClass}><b>@{handle}</b> {post.caption}</div>
      </div>
    )
  }

  if (post.platform === 'instagram') {
    return (
      <div className="perf-pv perf-pv-instagram">
        <div className="perf-pv-head ig">
          <Avatar client={client} account={account} size={28} ring />
          <span className="perf-pv-name">{handle}</span>
        </div>
        <Media />
        <div className="perf-pv-actions ig">
          <span><Icon.Heart width={16} height={16} /></span>
          <span><Icon.Bubble width={16} height={16} /></span>
          <span><Icon.Send width={16} height={16} /></span>
        </div>
        <div className="perf-pv-likes">{fmtNum(post.likes)} likes</div>
        <div className={bodyClass}><b>{handle}</b> {post.caption}</div>
      </div>
    )
  }

  // A newsletter issue leads with its headline — unlike a social post, where
  // the caption IS the content. `title` is the real Substack post title and
  // `caption` its subtitle, so both are worth showing.
  if (post.platform === 'substack') {
    return (
      <div className="perf-pv perf-pv-substack">
        <div className="perf-pv-byline">
          <Avatar client={client} account={account} size={22} />
          <span>{name}</span>
          <span className="perf-pv-pub">{fmtDate(post.publishedAt)}</span>
        </div>
        {media && <Media />}
        <div className="perf-pv-title">{post.title}</div>
        <div className={`${bodyClass} article`}>{post.caption}</div>
        <div className="perf-pv-actions">
          <span><Icon.Heart width={14} height={14} /> {fmtNum(post.likes)}</span>
          <span><Icon.Bubble width={14} height={14} /> {fmtNum(post.comments)}</span>
          <span><Icon.Repost width={14} height={14} /> {fmtNum(post.shares)}</span>
        </div>
      </div>
    )
  }

  if (post.platform === 'x') {
    return (
      <div className="perf-pv perf-pv-x">
        <div className="perf-pv-head">
          <Avatar client={client} account={account} size={32} />
          <div className="perf-pv-meta">
            <span className="perf-pv-name">
              {name} <span className="perf-pv-handle">@{handle} · {fmtDate(post.publishedAt)}</span>
            </span>
          </div>
        </div>
        <div className={bodyClass}>{post.caption}</div>
        {media && <Media />}
        <div className="perf-pv-actions x">
          <span><Icon.Bubble width={14} height={14} /> {fmtNum(post.comments)}</span>
          <span><Icon.Repost width={14} height={14} /> {fmtNum(post.shares)}</span>
          <span><Icon.Heart width={14} height={14} /> {fmtNum(post.likes)}</span>
          {post.views != null && <span><Icon.Eye width={14} height={14} /> {fmtNum(post.views)}</span>}
        </div>
      </div>
    )
  }

  // Anything that is not Instagram or X renders the LinkedIn-style chrome.
  return (
    <div className="perf-pv perf-pv-linkedin">
      <div className="perf-pv-head">
        <Avatar client={client} account={account} />
        <div className="perf-pv-meta">
          <span className="perf-pv-name">{name}</span>
          <span className="perf-pv-sub2">{fmtDate(post.publishedAt)} · 🌐</span>
        </div>
      </div>
      <div className={bodyClass}>{post.caption}</div>
      {media && <Media />}
      <div className="perf-pv-actions">
        <span><Icon.ThumbUp width={14} height={14} /> {fmtNum(post.likes)}</span>
        <span><Icon.Bubble width={14} height={14} /> {fmtNum(post.comments)}</span>
        <span><Icon.Repost width={14} height={14} /> {fmtNum(post.shares)}</span>
      </div>
    </div>
  )
}

// ─── Card in the grid ───────────────────────────────────────────────────────
export function PerfPostCard({ post, client, account, showPlatform, onOpen }) {
  const stats = (CARD_STATS[post.platform] || CARD_STATS.linkedin)(post)
  const color = PLATFORM_COLORS[post.platform]

  return (
    <div
      className="card perf-post-card"
      role="button" tabIndex={0}
      onClick={() => onOpen(post)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(post) } }}
    >
      {showPlatform && (
        <span className="perf-post-card-badge" style={{ background: `${color}1a`, color }}>
          {PLATFORM_LABELS[post.platform]}
        </span>
      )}
      <PostChrome post={post} client={client} account={account} />
      <div className="perf-post-card-stats">
        {stats.map((s) => (
          <div className="perf-post-card-stat" key={s.l}>
            <span className="eyebrow">{s.l}</span>
            <span className="perf-post-card-statval">{fmtNum(s.v)}</span>
          </div>
        ))}
        <span className="perf-post-card-open">Open <Icon.Arrow className="arrow" width={12} height={12} /></span>
      </div>
    </div>
  )
}

export { fmtDate }
