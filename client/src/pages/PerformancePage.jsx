import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Icon } from '../icons.jsx'
import { Modal } from '../components/Modal.jsx'
import { PerfPostCard, PostChrome, fmtDate } from '../components/PerfPostCard.jsx'
import { ChannelSetup } from '../components/ChannelSetup.jsx'
import { Skel, GallerySkeleton } from '../components/Skeleton.jsx'
import { getSocial, refreshSocial, logClient } from '../api.js'
import {
  PLATFORM_COLORS, PLATFORM_LABELS, PLATFORM_ORDER,
  buildMetrics, buildAllMetrics, buildPlatformSummary, buildAllSummary,
  allPosts, POST_SORTS, postSortValue,
  fmtNum, fmtPct, fmtMetric, followerWord, followerLabel,
} from '../performanceLive.js'

// ─── Constants ────────────────────────────────────────────────────────────────
// Period scopes the trend series (the sparklines), which are built from past
// refresh snapshots and so really do vary by window. It does NOT filter the
// post grid: a scrape only returns the 10 newest posts, so a window over what
// we hold could only ever subtract. See visiblePosts.
//
// Account-level figures (followers, engagement rate) are point-in-time
// readings from the last refresh, not windowed — the scrape sees "now".
const PERIODS = [
  { id: '7d', days: 7 },
  { id: '30d', days: 30 },
  { id: '90d', days: 90 },
  { id: 'all', days: null },
]
const PERIOD_WORDS = { '7d': '7 days', '30d': '30 days', '90d': '90 days', all: 'all time' }

// Posts the grid shows before "View all". The archive accumulates across
// refreshes, so this keeps the first screen readable; every post is already in
// memory and the heatmap reads all of them regardless.
const POSTS_PREVIEW = 8

// ─── Monoline platform marks (same stroke style as icons.jsx) ───────────────
const PLATFORM_PATHS = {
  instagram: (
    <>
      <rect x="3.3" y="3.3" width="17.4" height="17.4" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="16.9" cy="7.1" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  linkedin: (
    <>
      <rect x="3.3" y="3.3" width="17.4" height="17.4" rx="3" />
      <circle cx="8.1" cy="8.3" r="1" fill="currentColor" stroke="none" />
      <path d="M8.1 11.3v6" />
      <path d="M12.3 17.3v-3.6a2 2 0 0 1 4 0v3.6" />
      <path d="M12.3 11.3v2" />
    </>
  ),
  x: (<><path d="M5.3 5.3l13.4 13.4" /><path d="M18.7 5.3L5.3 18.7" /></>),
  // Substack: two rules over a filled chevron, the publication mark.
  substack: (
    <>
      <path d="M4.5 5.2h15" />
      <path d="M4.5 9.9h15" />
      <path d="M4.5 14.6v4.2l7.5-3.4 7.5 3.4v-4.2z" />
    </>
  ),
  // TikTok: note stem off a filled disc — the public mark, in the same
  // stroke language as the other platform icons.
  tiktok: (
    <>
      <path d="M14.2 4v9.1a3.6 3.6 0 1 1-2.4-3.4" />
      <path d="M14.2 7.4c1.15 1.35 2.85 2.25 4.8 2.5" />
    </>
  ),
}

function PlatformIcon({ id, size = 15, color }) {
  if (!PLATFORM_PATHS[id]) return null
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      style={{ color: color || PLATFORM_COLORS[id], flexShrink: 0 }}
      role="img" aria-label={PLATFORM_LABELS[id]}
    >
      {PLATFORM_PATHS[id]}
    </svg>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function deltaStr(d, format) {
  if (d == null) return null
  const sign = d >= 0 ? '+' : ''
  return format === 'pct' ? `${sign}${d.toFixed(1)}pt` : `${sign}${d.toFixed(1)}%`
}

function sparkPath(values, w, h) {
  const nums = values.filter((v) => typeof v === 'number')
  if (nums.length < 2) return ''
  const min = Math.min(...nums), max = Math.max(...nums), range = max - min || 1
  const step = w / (nums.length - 1)
  return nums.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`).join(' ')
}

function Sparkline({ values, color = 'var(--rose-deep)', w = 120, h = 22, className }) {
  const pts = (values || []).filter((v) => typeof v === 'number')
  if (pts.length < 2) return <span className="perf-spark-empty">—</span>
  return (
    <svg className={className} viewBox={`0 0 ${w} ${h + 6}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points={sparkPath(pts, w, h)} fill="none" stroke={color} strokeWidth="1.7"
        strokeLinecap="round" strokeLinejoin="round" transform="translate(0,3)"
      />
    </svg>
  )
}

// Rounds an interval to a readable step (1, 2, 5 × 10^n).
function niceNum(range, round) {
  if (!(range > 0)) return 1
  const exp = Math.floor(Math.log10(range))
  const frac = range / 10 ** exp
  const nice = round
    ? (frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10)
    : (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10)
  return nice * 10 ** exp
}

function niceScale(min, max, tickCount = 6) {
  if (min === max) { min -= Math.abs(min) * 0.1 || 1; max += Math.abs(max) * 0.1 || 1 }
  const pad = (max - min) * 0.12
  const step = niceNum(niceNum(max + pad - (min - pad), false) / (tickCount - 1), true)
  const niceMin = Math.max(0, Math.floor((min - pad) / step) * step)
  const niceMax = Math.ceil((max + pad) / step) * step
  const ticks = []
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) ticks.push(v)
  return { min: niceMin, max: niceMax, ticks }
}

const fmtWhen = (iso) => {
  if (!iso) return null
  try {
    const d = new Date(iso)
    const mins = Math.round((Date.now() - d.getTime()) / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins} min ago`
    if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch { return null }
}

// ─── Summary strip ────────────────────────────────────────────────────────────
function SummaryStrip({ tiles }) {
  return (
    <div className="card perf-summary">
      {tiles.map((t) => (
        <div className="perf-summary-tile" key={t.label}>
          <span className="eyebrow">{t.label}</span>
          <span className="perf-summary-val">{t.value}</span>
          {t.note && <span className="perf-summary-note">{t.note}</span>}
        </div>
      ))}
    </div>
  )
}

// ─── Metric tab strip ─────────────────────────────────────────────────────────
function MetricTabs({ metrics, activeKey, onChange }) {
  return (
    <div className="perf-metric-tabs" role="tablist" aria-label="Select metric">
      {metrics.map((m) => (
        <button
          key={m.key}
          role="tab"
          aria-selected={m.key === activeKey}
          className={`perf-metric-tab ${m.key === activeKey ? 'active' : ''}`}
          onClick={() => onChange(m.key)}
        >
          <span className="perf-m-label">
            {m.label}
            {m.note && (
              <span className="perf-note-ico" title={m.note}>
                <Icon.Info width={11} height={11} />
              </span>
            )}
          </span>
          <span className="perf-m-val">{fmtMetric(m.value, m.format)}</span>
          {m.delta != null
            ? <span className={`perf-m-delta ${m.delta >= 0 ? 'up' : 'down'}`}>{deltaStr(m.delta, m.format)}</span>
            : <span className="perf-m-delta muted">no history yet</span>}
        </button>
      ))}
    </div>
  )
}

// ─── Trend chart — drawn from refresh snapshots ──────────────────────────────
function TrendChart({ metric, snapshotTimes }) {
  const VW = 1080, VH = 300
  const PAD = { top: 20, right: 20, bottom: 34, left: 62 }
  const plotW = VW - PAD.left - PAD.right
  const plotH = VH - PAD.top - PAD.bottom
  const [hoverIdx, setHoverIdx] = useState(null)

  const points = (metric?.sparkline || []).filter((v) => typeof v === 'number')

  // A scrape sees only "now", so a trend exists only once the same channel has
  // been refreshed more than once. Say so rather than drawing a fabricated line.
  if (points.length < 2) {
    return (
      <div className="perf-chart-empty">
        <Icon.BarChart width={22} height={22} />
        <p>
          <strong>No trend yet.</strong> A scrape captures a point in time, so this chart needs at
          least two refreshes to draw a line. Hit <strong>Refresh data</strong> again later and the
          history builds from there.
        </p>
      </div>
    )
  }

  const n = points.length
  const scale = niceScale(Math.min(...points), Math.max(...points), 6)
  const range = scale.max - scale.min || 1
  const x = (i) => PAD.left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2)
  const y = (v) => PAD.top + plotH - ((v - scale.min) / range) * plotH

  const pts = points.map((v, i) => ({ x: x(i), y: y(v), v }))
  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const area = `M${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L')} L${pts[n - 1].x.toFixed(1)},${PAD.top + plotH} L${pts[0].x.toFixed(1)},${PAD.top + plotH} Z`

  const labels = (snapshotTimes || []).slice(-n).map((t) => {
    try {
      return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    } catch { return '' }
  })
  // Keep the axis readable when many snapshots have accumulated.
  const labelEvery = Math.max(1, Math.ceil(n / 8))

  const handleMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * VW
    const idx = Math.round(((px - PAD.left) / plotW) * (n - 1))
    setHoverIdx(Math.max(0, Math.min(n - 1, idx)))
  }

  const hp = hoverIdx != null ? pts[hoverIdx] : null

  return (
    <div className="perf-chart-wrap">
      <svg className="perf-chart-svg" viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid meet"
        role="img" aria-label={`${metric.label} trend`}>
        {scale.ticks.map((val, i) => (
          <g key={i}>
            <line x1={PAD.left} y1={y(val).toFixed(1)} x2={VW - PAD.right} y2={y(val).toFixed(1)} className="perf-grid-line" />
            <text x={PAD.left - 10} y={(y(val) + 3.5).toFixed(1)} textAnchor="end" className="perf-axis-label">
              {fmtMetric(val, metric.format)}
            </text>
          </g>
        ))}
        <path d={area} className="perf-area" />
        <polyline points={line} className="perf-line-current" />
        {pts.map((p, i) => <circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r="3.4" className="perf-dot-current" />)}
        {labels.map((lbl, i) => (i % labelEvery === 0 || i === n - 1) && (
          <text key={i} x={x(i).toFixed(1)} y={VH - 8} textAnchor="middle" className="perf-axis-label">{lbl}</text>
        ))}
        {hp && (
          <g pointerEvents="none">
            <line x1={hp.x.toFixed(1)} y1={PAD.top} x2={hp.x.toFixed(1)} y2={PAD.top + plotH} className="perf-crosshair" />
            <circle cx={hp.x.toFixed(1)} cy={hp.y.toFixed(1)} r="4.5" className="perf-dot-current" stroke="var(--card)" strokeWidth="2" />
          </g>
        )}
        <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="transparent"
          onMouseMove={handleMove} onMouseLeave={() => setHoverIdx(null)} style={{ cursor: 'crosshair' }} />
      </svg>

      {hp && (
        <div className="perf-tooltip" style={{ left: `${(hp.x / VW) * 100}%`, top: `${(hp.y / VH) * 100}%` }}>
          <div className="perf-tt-date">{labels[hoverIdx]}</div>
          <div className="perf-tt-row">
            <span className="perf-tt-sw" style={{ background: 'var(--rose-deep)' }} />
            {fmtMetric(hp.v, metric.format)}
          </div>
        </div>
      )}

      <p className="perf-note">
        {n} refresh{n === 1 ? '' : 'es'} recorded · each point is one scrape
      </p>
    </div>
  )
}

// ─── Best time to post ────────────────────────────────────────────────────────
// Day-of-week × time-of-day over the posts we hold. This is the one question
// scraped timestamps can answer that a trend line can't: when does this account
// publish, and when does what it publishes actually land.

const HEAT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const HEAT_DAY_PLURAL = {
  Mon: 'Mondays', Tue: 'Tuesdays', Wed: 'Wednesdays', Thu: 'Thursdays',
  Fri: 'Fridays', Sat: 'Saturdays', Sun: 'Sundays',
}

// Three-hour buckets across the whole day. Eight columns rather than the six
// that cover office hours only — a 2am post is unusual, which makes it exactly
// the kind of thing the grid shouldn't quietly drop.
const HEAT_SLOT_H = 3
const HEAT_SLOTS = Array.from({ length: 24 / HEAT_SLOT_H }, (_, i) => i * HEAT_SLOT_H)
const hour12 = (h) => `${(h % 12) || 12}${h < 12 || h === 24 ? 'am' : 'pm'}`
const slotShort = (h) => `${(h % 12) || 12}${h < 12 ? 'a' : 'p'}`
const slotLong = (h) => `${hour12(h)}–${hour12((h + HEAT_SLOT_H) % 24 || 24)}`

// Sequential ramp: ONE hue (6° spread), monotone lightness, light→dark, checked
// against the card surface. Magnitude is the job here, so a single hue carries
// it — a second hue would imply categories that don't exist. The lightest step
// may sit close to the surface because slots with no posts take no fill at all,
// so "barely any" can never be misread as "none".
const HEAT_STEPS = ['#fae8ec', '#f0c6d0', '#e09fae', '#c8788a', '#a45264', '#762f40']
const HEAT_DARK_FROM = 4 // the two darkest steps need light text on them

// Below this the grid is mostly single-post cells, so "best time" would be
// dressing one lucky post up as a pattern. The heatmap still draws; the
// sentence above it changes to say what it actually knows.
const HEAT_CONFIDENT_N = 20

function PostingHeatmap({ posts, channel }) {
  const [hover, setHover] = useState(null)

  const { cells, dated, max, best, bestDay, bestSlot } = useMemo(() => {
    const interactions = (p) => (p.likes || 0) + (p.comments || 0) + (p.shares || 0)
    const timed = posts.filter((p) => p.publishedAt && !Number.isNaN(new Date(p.publishedAt).getTime()))

    // Shade by how a post did RELATIVE TO ITS OWN CHANNEL, never by raw
    // interactions. Two reasons, both visible in real data:
    //   · Across channels the scales don't compare — an account can average
    //     thousands of interactions on one platform and dozens on another, so
    //     an "all channels" grid shaded by raw counts is just the loudest
    //     channel wearing a cross-channel label.
    //   · Within a channel one viral post can out-score every other slot
    //     combined, crowning whatever hour it happened to go out at.
    // The median is the baseline precisely because it shrugs off that outlier;
    // a mean would be dragged to it. 1.0 = a typical post for that channel.
    const medians = {}
    for (const plat of new Set(timed.map((p) => p.platform))) {
      const vals = timed.filter((p) => p.platform === plat).map(interactions).sort((a, b) => a - b)
      const mid = Math.floor(vals.length / 2)
      const med = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2
      medians[plat] = med > 0 ? med : 1
    }

    const grid = HEAT_DAYS.map(() => HEAT_SLOTS.map(() => ({ count: 0, total: 0, score: 0 })))
    for (const p of timed) {
      const d = new Date(p.publishedAt)
      // JS weeks start Sunday; the grid reads Mon-first, like a calendar.
      const cell = grid[(d.getDay() + 6) % 7][Math.floor(d.getHours() / HEAT_SLOT_H)]
      cell.count += 1
      cell.total += interactions(p)
      cell.score += interactions(p) / medians[p.platform]
    }

    // A slot holding one post is an anecdote. Where any slot has two or more,
    // only those can be named as the best time — otherwise the headline is a
    // single post's luck stated as a finding.
    const hasRepeat = grid.some((row) => row.some((c) => c.count > 1))
    const minForBest = hasRepeat ? 2 : 1

    let peak = 0
    let top = null
    grid.forEach((row, r) => row.forEach((c, s) => {
      if (!c.count) return
      const avg = c.score / c.count
      if (avg > peak) peak = avg
      if (c.count >= minForBest && (!top || avg > top.avg)) top = { r, s, avg, count: c.count }
    }))

    // Collapsing the grid along each axis gives two findings a single cell
    // can't: the best DAY regardless of hour, and the best HOUR regardless of
    // day. Both pool far more posts than any one slot, so they hold up at a
    // sample size where a single cell is still an anecdote.
    const bestOf = (buckets) => buckets
      .map((b, i) => ({ i, avg: b.count ? b.score / b.count : 0, count: b.count }))
      .filter((b) => b.count)
      .sort((a, b) => b.avg - a.avg)[0] || null

    const dayTotals = grid.map((row) => row.reduce(
      (a, c) => ({ count: a.count + c.count, score: a.score + c.score }), { count: 0, score: 0 }))
    const slotTotals = HEAT_SLOTS.map((_, s) => grid.reduce(
      (a, row) => ({ count: a.count + row[s].count, score: a.score + row[s].score }), { count: 0, score: 0 }))

    return {
      cells: grid,
      dated: timed.length,
      max: peak,
      best: top,
      bestDay: bestOf(dayTotals),
      bestSlot: bestOf(slotTotals),
    }
  }, [posts])

  // Nothing to plot without timestamps — draw nothing rather than an empty grid.
  if (!dated || !best) return null

  const rawAvg = (c) => (c.count ? c.total / c.count : 0)
  const stepOf = (c) => {
    if (!c.count) return null
    if (!max) return 0
    return Math.min(HEAT_STEPS.length - 1, Math.floor((c.score / c.count / max) * HEAT_STEPS.length))
  }

  const scope = channel === 'all' ? 'all channels' : PLATFORM_LABELS[channel]
  const when = `${HEAT_DAY_PLURAL[HEAT_DAYS[best.r]]}, ${slotLong(HEAT_SLOTS[best.s])}`
  // Enough posts overall AND more than one behind the winning slot.
  const confident = dated >= HEAT_CONFIDENT_N && best.count > 1

  return (
    <div className="perf-section">
      <div className="perf-section-head">
        <div><span className="eyebrow">Timing</span><h2>Best time to post</h2></div>
      </div>

      <div className="card perf-timing perf-timing-split">
        {/* Findings on the left, grid on the right. The three stats are read off
            the same numbers the grid draws, so the panel is a summary of it
            rather than a second opinion. */}
        <div className="perf-timing-side">
          <span className="eyebrow">{confident ? 'Best time to post' : 'Most engagement so far'}</span>
          <p className="perf-timing-headline">{when}</p>

          <dl className="perf-timing-stats">
            {bestDay && (
              <div>
                <dt>Strongest day</dt>
                {/* Pooled across every hour, so it rests on far more posts than
                    any single cell does. */}
                <dd>{HEAT_DAY_PLURAL[HEAT_DAYS[bestDay.i]]} <em>{bestDay.count} posts</em></dd>
              </div>
            )}
            {bestSlot && (
              <div>
                <dt>Strongest hours</dt>
                <dd>{slotLong(HEAT_SLOTS[bestSlot.i])} <em>{bestSlot.count} posts</em></dd>
              </div>
            )}
            <div>
              <dt>Posts analysed</dt>
              <dd>{dated} <em>on {scope}</em></dd>
            </div>
          </dl>

          {/* Say plainly when the sample is too thin to call it a best time,
              rather than dressing one lucky post up as a finding. */}
          {!confident && (
            <p className="perf-timing-caveat">
              That's from {dated} post{dated === 1 ? '' : 's'} — read it as a hint, not a schedule.
            </p>
          )}
        </div>

        <div className="perf-heatmap-inner" onMouseLeave={() => setHover(null)}>
          <div className="perf-heatmap-scroll">
            <div className="perf-heatmap-grid" style={{ '--heat-cols': HEAT_SLOTS.length }}>
              <div className="perf-heatmap-row header">
                <span className="perf-heatmap-label-cell" />
                {HEAT_SLOTS.map((h) => (
                  <span key={h} className="perf-heatmap-col-head">{slotShort(h)}</span>
                ))}
              </div>
              {HEAT_DAYS.map((day, r) => (
                <div className="perf-heatmap-row" key={day}>
                  <span className="perf-heatmap-label-cell">{day}</span>
                  {HEAT_SLOTS.map((h, s) => {
                    const cell = cells[r][s]
                    const step = stepOf(cell)
                    return (
                      <div
                        key={h}
                        className={`perf-heatmap-cell ${cell.count ? '' : 'empty'} ${r === best.r && s === best.s ? 'peak' : ''}`}
                        style={cell.count ? { background: HEAT_STEPS[step] } : undefined}
                        onMouseEnter={() => setHover({ r, s, cell })}
                        aria-label={`${day} ${slotLong(h)}: ${cell.count} post${cell.count === 1 ? '' : 's'}`}
                      >
                        {/* The count sits in the cell, so colour is never the
                            only channel carrying the value. */}
                        {cell.count > 0 && (
                          <span className={`perf-heatmap-score ${step >= HEAT_DARK_FROM ? 'on-dark' : ''}`}>
                            {cell.count}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Positioned against .perf-heatmap-inner, so it must sit outside the
              scroll container or it would scroll away from the tile. */}
          {hover && (
            <div className="perf-heatmap-tooltip">
              <strong>{HEAT_DAYS[hover.r]} · {slotLong(HEAT_SLOTS[hover.s])}</strong>
              <br />
              {hover.cell.count
                ? `${hover.cell.count} post${hover.cell.count === 1 ? '' : 's'} · ${fmtNum(Math.round(rawAvg(hover.cell)))} interactions avg. · ${(hover.cell.score / hover.cell.count).toFixed(1)}× a typical post`
                : 'Nothing posted in this slot'}
            </div>
          )}

          <div className="perf-heatmap-foot">
            <span className="perf-heatmap-legend">
              Less
              {HEAT_STEPS.map((c) => <i key={c} style={{ background: c }} />)}
              More
            </span>
            <span className="perf-heatmap-scale">
              Shade is how posts in that slot did against a typical post{channel === 'all' ? ' on their own channel' : ''} ·
              the number is how many landed there · times are local
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Channel breakdown ────────────────────────────────────────────────────────
function ChannelBreakdown({ channels, history, activeChannel, onSelect }) {
  const rows = PLATFORM_ORDER.filter((p) => channels?.[p]?.account)
  if (!rows.length) return null

  return (
    <div className="perf-section">
      <div className="perf-section-head">
        <div><span className="eyebrow">Overview</span><h2>Channels at a glance</h2></div>
      </div>
      <div className="card perf-breakdown">
        {rows.map((id) => {
          const c = channels[id]
          const series = (history?.[id] || []).map((h) => h.engagementRate).filter((v) => typeof v === 'number')
          return (
            <div
              key={id}
              className={`perf-bd-row ${activeChannel === id ? 'active' : ''}`}
              onClick={() => onSelect(id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id) } }}
              role="button" tabIndex={0}
            >
              <span className="perf-bd-plat">
                <PlatformIcon id={id} size={16} />
                {PLATFORM_LABELS[id]}
              </span>
              <Sparkline values={series} color={PLATFORM_COLORS[id]} className="perf-bd-spark" />
              {/* Both figures depend on a public follower count. Where the
                  platform withholds it, say so once rather than printing two
                  em-dashes that look like a loading state. */}
              <span className="perf-bd-val">
                {c.engagementRate != null ? fmtPct(c.engagementRate) : <span className="perf-bd-na">n/a</span>}
              </span>
              <span className="perf-bd-formula">
                {c.account.followers != null
                  ? `${fmtNum(c.account.followers)} ${followerWord(id)}`
                  : `${followerLabel(id).toLowerCase()} not public`}
              </span>
            </div>
          )
        })}
        <div className="perf-bd-foot">
          Engagement rate is (likes + comments + shares) ÷ followers, averaged per post — the same
          formula on every channel, so these figures are directly comparable.
        </div>
      </div>
    </div>
  )
}

// ─── Post detail ──────────────────────────────────────────────────────────────
function PostDetailModal({ post, client, account, onClose }) {
  const color = PLATFORM_COLORS[post.platform]
  const thread = Array.isArray(post.commentThread) ? post.commentThread : []
  const stats = [
    { l: post.platform === 'linkedin' ? 'Reactions' : 'Likes', v: post.likes },
    { l: 'Comments', v: post.comments },
    { l: post.platform === 'x' ? 'Reposts' : 'Shares', v: post.shares },
    ...(post.views != null ? [{ l: 'Views', v: post.views }] : []),
  ]
  const interactions = (post.likes || 0) + (post.comments || 0) + (post.shares || 0)

  return (
    <Modal onClose={onClose} wide className="perf-detail-modal">
      <div className="perf-detail-head">
        <span className="perf-detail-badge" style={{ background: `${color}1a`, color }}>
          <PlatformIcon id={post.platform} size={14} />
          {PLATFORM_LABELS[post.platform]}
        </span>
        <span className="perf-detail-date">
          {post.publishedAt
            ? `Published ${new Date(post.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`
            : 'Publish date unavailable'}
        </span>
      </div>

      <div className="perf-detail-grid">
        <div className="perf-detail-post">
          <PostChrome post={post} client={client} account={account} full />
        </div>
        <div className="perf-detail-side">
          <span className="eyebrow">Performance</span>
          <div className="perf-detail-stats">
            {stats.map((s) => (
              <div className="perf-detail-stat" key={s.l}>
                <span className="eyebrow">{s.l}</span>
                <span className="perf-detail-statval">{fmtNum(s.v)}</span>
              </div>
            ))}
            <div className="perf-detail-stat">
              <span className="eyebrow">Total interactions</span>
              <span className="perf-detail-statval">{fmtNum(interactions)}</span>
            </div>
          </div>
          {post.url && (
            <a className="btn btn-ghost btn-sm" href={post.url} target="_blank" rel="noreferrer">
              View on {PLATFORM_LABELS[post.platform]} <Icon.Arrow className="arrow" />
            </a>
          )}
          <p className="perf-note">
            <Icon.Info width={12} height={12} />
            Reach, impressions and saves aren’t shown because public scraping can’t see them —
            they only exist behind an owner-authenticated platform API.
          </p>
        </div>
      </div>

      <div className="perf-comments">
        <span className="eyebrow">
          Comments · {fmtNum(thread.length ? thread.length : post.comments)}
          {thread.length > 0 && post.comments != null && post.comments > thread.length
            ? ` of ${fmtNum(post.comments)}`
            : ''}
        </span>
        {thread.length ? (
          <>
            <div className="perf-comment-list">
              {thread.map((c, i) => (
                <div className="perf-comment" key={c.id || `${c.handle || c.author}-${i}`}>
                  <span className="perf-comment-ava">
                    {(c.author || c.handle || '?').charAt(0).toUpperCase()}
                  </span>
                  <div className="perf-comment-body">
                    <div className="perf-comment-head">
                      <span className="perf-comment-author">{c.author || c.handle || 'user'}</span>
                      {c.handle && <span className="perf-comment-handle">@{c.handle}</span>}
                      {c.publishedAt && (
                        <span className="perf-comment-time">{fmtWhen(c.publishedAt)}</span>
                      )}
                    </div>
                    <div className="perf-comment-text">{c.text}</div>
                    {c.likes != null && (
                      <div className="perf-comment-foot">
                        <Icon.Heart width={11} height={11} /> {fmtNum(c.likes)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {post.comments != null && post.comments > thread.length && (
              <p className="perf-comments-more">
                Showing {thread.length} of {fmtNum(post.comments)} public comments.
              </p>
            )}
          </>
        ) : (
          <p className="perf-comments-empty">
            {post.comments
              ? 'Comment count is scraped, but no comment text came back for this post — the platform may hide threads, or the comments run timed out. Refresh to try again.'
              : 'No public comments on this post.'}
          </p>
        )}
      </div>
    </Modal>
  )
}

// ─── Posts ────────────────────────────────────────────────────────────────────
function PostsSection({ posts, channels, client, channel, loading, period, newestPostAt }) {
  const [sortMode, setSortMode] = useState('recent')
  const [sortKey, setSortKey] = useState(POST_SORTS[0].key)
  const [activePost, setActivePost] = useState(null)
  // The archive grows without limit now that posts accumulate across refreshes,
  // so the grid opens on a readable page of them rather than every post ever
  // scraped. Everything is already loaded — this is a display cap, not a fetch.
  const [showAll, setShowAll] = useState(false)

  const sorted = useMemo(() => {
    const list = [...posts]
    if (sortMode === 'recent') {
      list.sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))
    } else {
      list.sort((a, b) => postSortValue(b, sortKey) - postSortValue(a, sortKey))
    }
    return list
  }, [posts, sortMode, sortKey])

  const title = channel === 'all' ? 'Post performance' : `Recent ${PLATFORM_LABELS[channel]} posts`

  // The grid ignores the period control on purpose (see visiblePosts). Say so
  // when the two disagree, so a year-old post sitting under a "30 days" filter
  // reads as what it is — the newest thing the account has published — rather
  // than as this month's activity.
  const periodDays = PERIODS.find((p) => p.id === period)?.days
  const staleBy = periodDays && newestPostAt
    ? Math.floor((Date.now() - new Date(newestPostAt).getTime()) / 86400000) - periodDays
    : 0

  const visible = showAll ? sorted : sorted.slice(0, POSTS_PREVIEW)
  const hidden = sorted.length - visible.length

  return (
    <div className="perf-section">
      <div className="perf-section-head">
        <div><span className="eyebrow">Posts</span><h2>{title}</h2></div>
        <div className="perf-sort-group" role="group" aria-label="Sort posts">
          <div className="perf-sort-toggle">
            <button className={sortMode === 'recent' ? 'active' : ''} onClick={() => setSortMode('recent')}>Recent</button>
            <button className={sortMode === 'popular' ? 'active' : ''} onClick={() => setSortMode('popular')}>Popular</button>
          </div>
          {sortMode === 'popular' && (
            <div className="perf-rank-pills">
              {POST_SORTS.map((s) => (
                <button key={s.key} className={`perf-rank-pill ${sortKey === s.key ? 'active' : ''}`} onClick={() => setSortKey(s.key)}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <GallerySkeleton count={8} />
      ) : sorted.length === 0 ? (
        <div className="card perf-empty">
          <Icon.Pen width={20} height={20} />
          <p>No posts scraped for this channel yet. Hit Refresh to pull the latest.</p>
        </div>
      ) : (
        <>
          <div className="perf-post-grid">
            {staleBy > 0 && (
              <p className="perf-post-grid-note">
                Nothing published in the last {PERIOD_WORDS[period]}. Showing the {sorted.length} most
                recent {channel === 'all' ? '' : `${PLATFORM_LABELS[channel]} `}posts — the newest is
                from {fmtDate(newestPostAt, true)}.
              </p>
            )}
            {visible.map((p) => (
              <div className="perf-post-item" key={`${p.platform}-${p.externalId}`}>
                <PerfPostCard
                  post={p}
                  client={client}
                  account={channels?.[p.platform]?.account}
                  showPlatform={channel === 'all'}
                  onOpen={setActivePost}
                />
              </div>
            ))}
          </div>
          {(hidden > 0 || showAll) && (
            <div className="perf-post-more">
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAll(!showAll)}>
                {showAll
                  ? <>Show fewer <Icon.Chevron className="perf-chev-open" width={12} height={12} /></>
                  : <>View all {sorted.length} posts <Icon.Arrow className="arrow" width={12} height={12} /></>}
              </button>
            </div>
          )}
        </>
      )}

      {activePost && (
        <PostDetailModal
          post={activePost}
          client={client}
          account={channels?.[activePost.platform]?.account}
          onClose={() => setActivePost(null)}
        />
      )}
    </div>
  )
}

// ─── Main Performance Page ──────────────────────────────────────────────────
export default function PerformancePage() {
  const { client } = useOutletContext()

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)
  const [channel, setChannel] = useState('all')
  const [period, setPeriod] = useState('30d')
  const [activeMetricKey, setActiveMetricKey] = useState(null)
  const [setupOpen, setSetupOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      setData(await getSocial(client.id))
    } catch (err) {
      setErrorMsg(err.message || 'Could not load performance data.')
    } finally {
      setLoading(false)
    }
  }, [client.id])

  useEffect(() => { load() }, [load])

  const handleRefresh = async () => {
    setRefreshing(true)
    setErrorMsg(null)
    const target = channel === 'all' ? undefined : channel
    logClient('info', 'refresh start', { client: client.id, channel: target || 'all' })
    try {
      const out = await refreshSocial(client.id, target)
      const results = out?.results || []
      for (const r of results) {
        if (r.ok) logClient('info', `${r.platform} ok`, r)
        else logClient('error', `${r.platform} failed`, r.error || r)
      }
      if (!results.length) logClient('warn', 'refresh returned no per-channel results', out)
      setData((prev) => ({ ...prev, ...out }))
    } catch (err) {
      logClient('error', 'refresh error', err.message || String(err))
      setErrorMsg(err.message || 'Refresh failed.')
    } finally {
      setRefreshing(false)
    }
  }

  const channels = data?.channels || {}
  const history = data?.history || {}
  const configured = data?.configured || []
  const liveIds = PLATFORM_ORDER.filter((p) => channels[p]?.account)
  const failed = PLATFORM_ORDER.filter((p) => channels[p]?.error)

  // Every post we hold for a channel. Deliberately NOT filtered by `period`.
  //
  // A scrape only ever returns the 10 most recent posts per channel (see
  // MAX_POSTS in server/apify.js), so a date window applied to them can only
  // ever hide posts we already have — it can never surface more, because there
  // is nothing more behind it. On an account that posts infrequently that made
  // the grid go completely empty while telling the user to "try a wider date
  // range", when widening it was the only thing that could ever work.
  //
  // `period` still drives the trend metrics below, which genuinely are a
  // series measured over time.
  const visiblePosts = useMemo(() => (
    channel === 'all'
      ? allPosts(channels)
      : (channels[channel]?.posts || []).map((p) => ({ ...p, platform: channel }))
  ), [channels, channel])

  // How stale the newest post is, so the section can say so rather than let a
  // year-old grid pass for current activity.
  const newestPostAt = useMemo(() => (
    visiblePosts.reduce((a, p) => (p.publishedAt && (!a || p.publishedAt > a) ? p.publishedAt : a), null)
  ), [visiblePosts])

  const metrics = useMemo(() => (
    channel === 'all'
      ? buildAllMetrics(channels, history)
      : buildMetrics(channel, channels[channel], history[channel] || [])
  ), [channel, channels, history])

  const summaryTiles = useMemo(() => (
    channel === 'all' ? buildAllSummary(channels) : buildPlatformSummary(channel, channels[channel])
  ), [channel, channels])

  const resolvedKey = metrics.find((m) => m.key === activeMetricKey)?.key ?? metrics[0]?.key
  const activeMetric = metrics.find((m) => m.key === resolvedKey)
  const snapshotTimes = useMemo(() => {
    if (channel === 'all') {
      const first = liveIds[0]
      return (history[first] || []).map((h) => h.at)
    }
    return (history[channel] || []).map((h) => h.at)
  }, [channel, history, liveIds])

  const insight = useMemo(() => {
    if (!liveIds.length) return null
    if (channel === 'all') {
      const rated = liveIds.map((p) => ({ p, r: channels[p].engagementRate })).filter((x) => x.r != null)
      if (!rated.length) return `${liveIds.length} channel${liveIds.length === 1 ? '' : 's'} connected.`
      const top = rated.reduce((a, x) => (x.r > a.r ? x : a))
      return `Across ${liveIds.length} connected channel${liveIds.length === 1 ? '' : 's'}, ${PLATFORM_LABELS[top.p]} leads on engagement at ${fmtPct(top.r)}.`
    }
    const c = channels[channel]
    if (!c?.account) return null
    // Built from the parts that exist. A Substack with no public subscriber
    // count would otherwise read "— subscribers · — engagement across the 10
    // most recent posts", which is three facts of which only one is true.
    const bits = []
    if (c.account.followers != null) bits.push(`${fmtNum(c.account.followers)} ${followerWord(channel)}`)
    if (c.engagementRate != null) bits.push(`${fmtPct(c.engagementRate)} engagement`)
    bits.push(`${c.posts?.length || 0} posts analysed`)
    return `${bits.join(' · ')}.`
  }, [channel, channels, liveIds])

  const lastSynced = fmtWhen(data?.lastSyncedAt)
  const hasAnyData = liveIds.length > 0

  // ── Nothing configured: point at Profile rather than showing an empty shell.
  const nothingConfigured = !loading && configured.length === 0

  return (
    <div className="view">
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <span className="eyebrow">{client.name} · Analytics</span>
            <h1 style={{ marginTop: 8 }}>Performance</h1>
          </div>
          <div className="perf-head-actions">
            <div className="perf-period-group" role="group" aria-label="Time period">
              {PERIODS.map((p) => (
                <button
                  key={p.id}
                  className={`perf-period-btn ${period === p.id ? 'active' : ''}`}
                  onClick={() => setPeriod(p.id)}
                  aria-pressed={period === p.id}
                >
                  {p.id === 'all' ? 'All' : p.id}
                </button>
              ))}
            </div>
            <button
              className={`btn btn-ghost btn-sm ${setupOpen ? 'is-on' : ''}`}
              onClick={() => setSetupOpen((o) => !o)}
              aria-expanded={setupOpen}
            >
              <Icon.Layers width={13} height={13} /> Channels
            </button>
            <button
              className="btn btn-ghost btn-sm perf-refresh"
              onClick={handleRefresh}
              disabled={refreshing || nothingConfigured}
              title={nothingConfigured ? 'Add an account name under Channels first' : 'Scrape the latest public data'}
            >
              {refreshing ? 'Refreshing…' : 'Refresh data'}
            </button>
          </div>
        </div>
        {loading
          ? <Skel w={360} h={14} style={{ marginTop: 12 }} />
          : (
            <p className="lede">
              {insight || 'Live public data from your connected channels.'}
              {lastSynced && <span className="perf-synced"> · updated {lastSynced}</span>}
            </p>
          )}
      </div>

      {/* ── Errors ── */}
      {errorMsg && (
        <div className="card perf-empty perf-error">
          <Icon.Info width={20} height={20} />
          <p><strong>Couldn’t refresh:</strong> {errorMsg}</p>
          <button className="btn btn-ghost btn-sm" onClick={handleRefresh}>Try again</button>
        </div>
      )}

      {failed.length > 0 && (
        <div className="card perf-empty perf-error perf-error--soft">
          <Icon.Info width={18} height={18} />
          <div>
            {failed.map((p) => (
              <p key={p}><strong>{PLATFORM_LABELS[p]}:</strong> {channels[p].error}</p>
            ))}
          </div>
        </div>
      )}

      {/* ── Channel setup — the account names that get scraped ── */}
      {(setupOpen || nothingConfigured) && !loading && (
        <ChannelSetup
          client={client}
          onClose={setupOpen ? () => setSetupOpen(false) : undefined}
          onSaved={(count) => {
            setSetupOpen(false)
            load()
            if (count > 0) setErrorMsg(null)
          }}
        />
      )}

      {nothingConfigured ? (
        !loading && (
          <p className="foot-note">
            <Icon.Info width={12} height={12} />
            {/* One span, so .foot-note's flex layout sees a single text child —
                inline <strong> as a direct child becomes its own flex item and
                breaks the sentence into columns. */}
            <span>
              Add at least one account name above, then hit <strong>Refresh data</strong> to pull
              live figures. The same handles are editable under Profile → Channels.
            </span>
          </p>
        )
      ) : (
        <>
          {/* ── Channel filter ── */}
          <div className="perf-channels" role="tablist" aria-label="Filter by channel">
            <button
              role="tab" aria-selected={channel === 'all'}
              className={`perf-ch-btn ${channel === 'all' ? 'active' : ''}`}
              onClick={() => { setChannel('all'); setActiveMetricKey(null) }}
            >
              All channels
            </button>
            {PLATFORM_ORDER.map((id) => {
              const isConfigured = configured.some((c) => c.platform === id)
              if (!isConfigured) return null
              const hasData = !!channels[id]?.account
              return (
                <button
                  key={id}
                  role="tab" aria-selected={channel === id}
                  className={`perf-ch-btn ${channel === id ? 'active' : ''} ${hasData ? '' : 'disconnected'}`}
                  onClick={() => { setChannel(id); setActiveMetricKey(null) }}
                  title={hasData ? undefined : 'No data yet — hit Refresh'}
                >
                  <PlatformIcon id={id} size={14} color={channel === id ? 'currentColor' : undefined} />
                  {PLATFORM_LABELS[id]}
                </button>
              )
            })}
          </div>

          {/* ── Never refreshed yet ── */}
          {!loading && !hasAnyData ? (
            <div className="card perf-empty">
              <Icon.BarChart width={20} height={20} />
              <p>
                {configured.length} channel{configured.length === 1 ? '' : 's'} configured, but no data
                pulled yet. Hit <strong>Refresh data</strong> to scrape the latest public figures.
              </p>
              <button className="btn btn-primary btn-sm" onClick={handleRefresh} disabled={refreshing}>
                {refreshing ? 'Refreshing…' : 'Refresh data'}
              </button>
            </div>
          ) : (
            <>
              {loading
                ? <Skel h={104} r={12} style={{ marginBottom: 'var(--sp-7)' }} />
                : summaryTiles && <SummaryStrip tiles={summaryTiles} />}

              {!loading && metrics.length > 0 && (
                <div className="card perf-chart-card">
                  <MetricTabs metrics={metrics} activeKey={resolvedKey} onChange={setActiveMetricKey} />
                  {activeMetric && <TrendChart metric={activeMetric} snapshotTimes={snapshotTimes} />}
                </div>
              )}

              {/* Cross-channel comparison — only meaningful on the All tab.
                  On a single-platform tab it's the one section that isn't
                  about that platform, so it reads as stray overall data. */}
              {channel === 'all' && (
                <ChannelBreakdown
                  channels={channels}
                  history={history}
                  activeChannel={channel}
                  onSelect={(id) => { setChannel(id); setActiveMetricKey(null) }}
                />
              )}

              {!loading && <PostingHeatmap posts={visiblePosts} channel={channel} />}

              <PostsSection
                posts={visiblePosts}
                channels={channels}
                client={client}
                channel={channel}
                loading={loading}
                period={period}
                newestPostAt={newestPostAt}
              />
            </>
          )}

          
        </>
      )}
    </div>
  )
}
