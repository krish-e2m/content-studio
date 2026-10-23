import { Modal } from './Modal.jsx'
import { Icon } from '../icons.jsx'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { fmtMetric } from '../performanceData.js'
import { mediaSrc } from '../api.js'

// Platform color swatches for thumbnail fallback
const PLATFORM_COLORS = {
  instagram: '#c1558b',
  linkedin:  '#2f6f9f',
  x:         '#2b2b2b',
  substack:  '#cf6b4a',
}

const PLATFORM_LABELS = {
  instagram: 'Instagram',
  linkedin:  'LinkedIn',
  x:         'X',
  substack:  'Substack',
}

// A single stat tile — mirrors the .stat card used on the Dashboard
function StatTile({ label, value, format, unavailable, privateMetric, note }) {
  return (
    <div className="card pstats-tile">
      <div className="pstats-tile-label eyebrow">{label}</div>
      {unavailable ? (
        <div className="pstats-na" title={note || 'Not available'}>—
          {note && <span className="pstats-na-why">{note}</span>}
        </div>
      ) : privateMetric ? (
        <div className="pstats-tile-val">
          {fmtMetric(value, format)}
          <span className="pstats-private" title="Private metric — available for connected accounts only (Instagram Graph API)">private</span>
        </div>
      ) : (
        <div className="pstats-tile-val">{fmtMetric(value, format)}</div>
      )}
    </div>
  )
}

// Per-platform tile layout
function InstagramTiles({ m, post }) {
  return (
    <>
      <StatTile label="Views / Reach" value={m.reach ?? m.views} />
      <StatTile label="Impressions" value={m.impressions ?? m.views} />
      <StatTile label="Likes" value={m.likes} />
      <StatTile label="Comments" value={m.comments} />
      <StatTile
        label="Saves"
        value={m.saves?.value ?? m.saves}
        privateMetric={m.saves?.private}
      />
      <StatTile
        label="Shares"
        value={m.shares?.value ?? m.shares}
        privateMetric={m.shares?.private}
      />
      {post.isReel && m.skip_rate != null && (
        <StatTile
          label="Skip Rate"
          value={m.skip_rate?.value ?? m.skip_rate}
          format="pct"
          unavailable={m.skip_rate?.available === false}
        />
      )}
    </>
  )
}

function LinkedInTiles({ m }) {
  return (
    <>
      <StatTile label="Impressions" value={m.impressions} />
      <StatTile label="Reach" value={m.reach} />
      <StatTile label="Reactions" value={m.reactions} />
      <StatTile label="Comments" value={m.comments} />
      <StatTile label="Reposts" value={m.reposts} />
      <StatTile label="Clicks" value={m.clicks} />
      <StatTile label="Engagement Rate" value={m.engagement_rate} format="pct" />
    </>
  )
}

function XTiles({ m }) {
  return (
    <>
      <StatTile label="Impressions" value={m.impressions} />
      <StatTile label="Likes" value={m.likes} />
      <StatTile label="Retweets" value={m.retweets} />
      <StatTile label="Replies" value={m.replies} />
      <StatTile label="Quotes" value={m.quotes} />
      <StatTile label="Bookmarks" value={m.bookmarks} />
      <StatTile label="Engagement Rate" value={m.engagement_rate} format="pct" />
    </>
  )
}

function SubstackTiles({ m }) {
  return (
    <>
      <StatTile label="Deliveries" value={m.deliveries} />
      <StatTile label="Opens" value={m.opens} />
      <StatTile label="Open Rate" value={m.open_rate} format="pct" />
      <StatTile label="Link Clicks" value={m.link_clicks} />
      <StatTile label="Likes" value={m.likes} />
      <StatTile label="Comments" value={m.comments} />
      <StatTile label="Shares" value={m.shares} />
      <StatTile label="Free Conversions" value={m.free_conversions} />
      <StatTile label="Paid Conversions" value={m.paid_conversions} />
    </>
  )
}

function PlatformTiles({ post }) {
  const m = post.metrics
  switch (post.platform) {
    case 'instagram': return <InstagramTiles m={m} post={post} />
    case 'linkedin':  return <LinkedInTiles m={m} />
    case 'x':         return <XTiles m={m} />
    case 'substack':  return <SubstackTiles m={m} />
    default:          return null
  }
}

const fmtDate = (iso) => {
  if (!iso) return ''
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  } catch { return iso }
}

// The platform-specific notes shown at the bottom of the modal
function PlatformNotes({ platform }) {
  if (platform === 'instagram') return (
    <div className="pstats-notes">
      <Icon.Info width={13} height={13} />
      <span>
        <strong>Saves</strong> and <strong>Shares</strong> are private metrics available only for your
        connected account — not competitor content. Instagram Graph API does not expose these
        for accounts you don't own.
      </span>
    </div>
  )
  if (platform === 'x') return (
    <div className="pstats-notes">
      <Icon.Info width={13} height={13} />
      <span>
        X does not provide a historical follower-count endpoint. Follower growth
        figures elsewhere are based on manual snapshots, not a live trend line.
      </span>
    </div>
  )
  if (platform === 'substack') return (
    <div className="pstats-notes">
      <Icon.Info width={13} height={13} />
      <span>
        Substack metrics are per-newsletter-issue, not per social post. Subscriber
        conversions attributed here are estimates from the Substack Publisher API.
      </span>
    </div>
  )
  return null
}

// ─── Main export ────────────────────────────────────────────────────────────
export function PostStatsModal({ post, onClose }) {
  const navigate = useNavigate()
  // client is in outlet context when modal is rendered inside the workspace
  let clientId = null
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const ctx = useOutletContext()
    clientId = ctx?.client?.id
  } catch {}

  const platColor = PLATFORM_COLORS[post.platform] || '#999'
  const platLabel = PLATFORM_LABELS[post.platform] || post.platform

  return (
    <Modal onClose={onClose} wide className="modal-post-stats">
      {/* Post identity */}
      <div className="pstats-head">
        <div className="pstats-thumb" style={{ background: platColor }}>
          {post.thumbUrl
            ? <img src={mediaSrc(post.thumbUrl)} alt="" />
            : <span className="pstats-thumb-platform">{platLabel[0]}</span>
          }
        </div>
        <div className="pstats-meta">
          <span className="pstats-platform-badge" style={{ background: platColor + '22', color: platColor }}>
            {platLabel}
            {post.isReel && <em> · Reel</em>}
            {post.isThread && <em> · Thread</em>}
          </span>
          <h3 className="pstats-title">{post.title}</h3>
          <span className="pstats-date eyebrow">Published {fmtDate(post.publishedAt)}</span>
        </div>
      </div>

      {/* Metric tiles */}
      <div className="pstats-tiles">
        <PlatformTiles post={post} />
      </div>

      {/* Platform-specific notes */}
      <PlatformNotes platform={post.platform} />

      {/* Navigation to Posts section */}
      {clientId && (
        <div className="pstats-footer">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              onClose()
              navigate(`/clients/${clientId}/posts`)
            }}
          >
            View in Posts <Icon.Arrow className="arrow" />
          </button>
        </div>
      )}
    </Modal>
  )
}
