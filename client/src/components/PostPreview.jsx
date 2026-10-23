import { useState } from 'react'
import { Icon } from '../icons.jsx'

/* Realistic per-platform post previews */
export function PostPreview({ client, platform, format, draft, visual, photos, topic }) {
  const name = client?.name || 'Your Brand'
  const who = client?.who || ''
  const accent = client?.accent || '#ebb7c2'
  const initial = name.charAt(0).toUpperCase()
  const handle = (name || 'brand').toLowerCase().replace(/[^a-z0-9]+/g, '')

  const [idx, setIdx] = useState(0)
  const photoIds = visual?.photoIds || (visual?.photoId ? [visual.photoId] : [])
  // images to flip through: uploaded/library photos carry `url`, AI visuals carry `src` (data-URL)
  const items = (photoIds.length > 0)
    ? photoIds.map((id) => photos.find((x) => x.id === id)).filter(Boolean)
    : (visual?.src ? [{ src: visual.src }] : [])
  const count = items.length
  const safeIdx = count ? Math.min(idx, count - 1) : 0
  const cur = items[safeIdx] || null
  // AI visuals carry `src` (a data-URL); uploaded/library photos carry `url`.
  const curSrc = cur?.src || cur?.url
  const curSwatch = cur?.swatch
  const go = (d) => setIdx(() => (count ? (safeIdx + d + count) % count : 0))

  const body = draft?.body || ''
  const subj = body.startsWith('Subject: ') ? body.split('\n')[0].replace('Subject: ', '') : null
  const text = (subj ? body.split('\n').slice(1).join('\n').trim() : body) || ''
  const tags = draft?.hashtags
  const isGraphic = visual?.path === 'graphic'

  const Img = ({ square, fallback }) => {
    // text-based graphic renders as an actual on-brand text card
    if (isGraphic) {
      return (
        <div className={`lp-img ${square ? 'square' : ''}`}>
          <div className="text-graphic">
            <span className="tg-eyebrow">{name}</span>
            <span className="tg-title">{topic || subj || text.split('\n')[0] || 'Your headline'}</span>
          </div>
        </div>
      )
    }
    if (!count && !fallback) return null
    return (
      <div 
        className={`lp-img ${square ? 'square' : ''} ${count > 1 ? 'carousel' : ''}`}
        style={count > 1 ? { height: 340, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0f2f5' } : {}}
      >
        {curSrc ? <img src={curSrc} alt="" style={count > 1 ? { height: '100%', maxHeight: '100%', width: '100%', objectFit: 'contain' } : {}} /> : <span className="swatch" style={{ background: curSwatch || 'linear-gradient(135deg,#f5d5dc,#ebb7c2)' }} />}
        {count > 1 && (
          <>
            <span className="lp-carousel">{safeIdx + 1}/{count}</span>
            <button className="lp-nav prev" onClick={() => go(-1)} aria-label="Previous image">‹</button>
            <button className="lp-nav next" onClick={() => go(1)} aria-label="Next image">›</button>
          </>
        )}
      </div>
    )
  }

  const Dots = () =>
    count > 1 ? (
      <div className="lp-dots">
        {items.map((_, i) => <button key={i} className={i === safeIdx ? 'on' : ''} onClick={() => setIdx(i)} aria-label={`Image ${i + 1}`} />)}
      </div>
    ) : null

  /* LinkedIn */
  if (platform === 'linkedin') {
    return (
      <div className="lp lp-linkedin">
        <div className="lp-head">
          <span className="lp-ava" style={{ background: accent }}>{initial}</span>
          <div className="lp-meta">
            <span className="lp-name">{name}</span>
            <span className="lp-sub">{who || 'Founder'}</span>
            <span className="lp-sub2">1h · 🌐</span>
          </div>
          <span className="lp-more">···</span>
        </div>
        <div className="lp-text">{text}{tags && <div className="lp-tags">{tags}</div>}</div>
        <Img />
        <Dots />
        <div className="lp-actions">
          <button><Icon.ThumbUp /> Like</button>
          <button><Icon.Bubble /> Comment</button>
          <button><Icon.Repost /> Repost</button>
          <button><Icon.Send /> Send</button>
        </div>
      </div>
    )
  }

  /* Instagram */
  if (platform === 'instagram') {
    return (
      <div className="lp lp-instagram">
        <div className="lp-head ig">
          <span className="lp-ava ig-ring" style={{ background: accent }}>{initial}</span>
          <span className="lp-name">{handle}</span>
          <span className="lp-more">···</span>
        </div>
        <Img fallback />
        <Dots />
        <div className="lp-actions ig">
          <span className="left"><Icon.Heart /><Icon.Bubble /><Icon.Send /></span>
          <span className="right"><Icon.Bookmark /></span>
        </div>
        <div className="lp-likes">1,248 likes</div>
        <div className="lp-caption"><b>{handle}</b> {text}{tags && <span className="lp-tags-inline"> {tags}</span>}</div>
      </div>
    )
  }

  /* Substack */
  if (platform === 'substack') {
    return (
      <div className="lp lp-substack">
        <div className="lp-pub">{name}</div>
        <h2 className="lp-title">{topic || subj || 'Untitled'}</h2>
        <div className="lp-byline"><span className="lp-ava sm" style={{ background: accent }}>{initial}</span> {name} · Jun 16</div>
        <Img />
        <Dots />
        <div className="lp-article">{text}</div>
        {tags && <div className="lp-tags">{tags}</div>}
      </div>
    )
  }

  /* Email */
  if (platform === 'email') {
    return (
      <div className="lp lp-email">
        <div className="lp-email-head">
          <span className="lp-ava sm" style={{ background: accent }}>{initial}</span>
          <div className="lp-meta">
            <span className="lp-name">{name} <span className="lp-email-addr">&lt;{handle}@mail.com&gt;</span></span>
            <span className="lp-sub">to me</span>
          </div>
        </div>
        <h2 className="lp-email-subject">{subj || topic || 'Newsletter'}</h2>
        <div className="lp-article">{text}</div>
        <Img />
        <Dots />
      </div>
    )
  }

  /* X */
  return (
    <div className="lp lp-x">
      <div className="lp-head">
        <span className="lp-ava" style={{ background: accent }}>{initial}</span>
        <div className="lp-meta"><span className="lp-name">{name} <span className="lp-handle">@{handle} · 1h</span></span></div>
        <span className="lp-more">···</span>
      </div>
      <div className="lp-text">{text}{tags && <div className="lp-tags">{tags}</div>}</div>
      <Img />
      <Dots />
      <div className="lp-actions x">
        <button><Icon.Bubble /> 24</button>
        <button><Icon.Repost /> 88</button>
        <button><Icon.Heart /> 412</button>
        <button><Icon.Eye /> 9.2K</button>
      </div>
    </div>
  )
}
