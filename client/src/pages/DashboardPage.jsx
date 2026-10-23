import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { Icon } from '../icons.jsx'
import { Modal } from '../components/Modal.jsx'
import { DashboardSkeleton } from '../components/Skeleton.jsx'
import { platformById } from '../data.js'
import { dotColor, iso, prettyDate } from '../lib/util.js'
import { getSocial } from '../api.js'
import { PLATFORM_COLORS, PLATFORM_LABELS, PLATFORM_ORDER, fmtPct, followerWord } from '../performanceLive.js'

const STATUS_ROWS = [
  { key: 'draft', label: 'Draft' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'published', label: 'Published' },
]

function Stat({ num, label }) {
  return <div className="card stat"><div className="num">{num}</div><div className="lbl">{label}</div></div>
}

export default function DashboardPage() {
  // `posts` is the live posts table (one row per platform). This page used to
  // read a `scheduled` key that the layout never provided, so every count here
  // silently fell back to 0 no matter how much real content existed.
  const {
    client, ideas, ideasReady, posts, postsReady,
    photos, photosReady, researchTopics, researchReady, startFromIdea,
  } = useOutletContext()
  const navigate = useNavigate()
  const go = (view) => navigate(`/clients/${client.id}/${view}`)
  // Clicking a thumbnail opens the image itself; the panel's "Library" button is
  // what navigates to the full Photo Library.
  const [previewPhoto, setPreviewPhoto] = useState(null)

  // Real scraped engagement for the Performance panel below. This panel used to
  // render ENGAGEMENT_RATES — a hardcoded mock (LinkedIn 2.9%, Instagram 5.0%,
  // Substack 54.7%) over a hardcoded channel list — so the Overview showed the
  // same invented figures for every client regardless of what was connected or
  // whether anything had ever been scraped. Reads the same cached endpoint the
  // Performance page does, so it costs nothing and never triggers a scrape.
  const [social, setSocial] = useState(null)
  const [socialReady, setSocialReady] = useState(false)
  useEffect(() => {
    let alive = true
    setSocialReady(false)
    getSocial(client.id)
      .then((d) => { if (alive) setSocial(d) })
      .catch(() => { if (alive) setSocial(null) })
      .finally(() => { if (alive) setSocialReady(true) })
    return () => { alive = false }
  }, [client.id])

  // One row per channel that has actually been scraped, richest first.
  const liveRates = useMemo(() => {
    const channels = social?.channels || {}
    return PLATFORM_ORDER
      .filter((id) => channels[id]?.account && channels[id]?.engagementRate != null)
      .map((id) => ({
        id,
        label: PLATFORM_LABELS[id],
        color: PLATFORM_COLORS[id],
        rate: channels[id].engagementRate,
        followers: channels[id].account.followers,
      }))
      .sort((a, b) => b.rate - a.rate)
  }, [social])

  // Guard against missing data so every count falls back to 0 rather than crashing.
  const safeIdeas = Array.isArray(ideas) ? ideas : []
  const safePosts = Array.isArray(posts) ? posts : []
  const safePhotos = Array.isArray(photos) ? photos : []
  const safeTopics = Array.isArray(researchTopics) ? researchTopics : []

  const scheduledCount = safePosts.filter((p) => p.status === 'scheduled').length
  const publishedCount = safePosts.filter((p) => p.status === 'published').length
  const platformsUsed = new Set(safePosts.map((p) => p.platform).filter(Boolean)).size
  const openTopicList = safeTopics.filter((t) => t.status !== 'done')
  const openTopics = openTopicList.length

  // Posts per channel, widest bar = busiest channel.
  const byChannel = useMemo(() => {
    const counts = new Map()
    safePosts.forEach((p) => {
      if (p.platform) counts.set(p.platform, (counts.get(p.platform) || 0) + 1)
    })
    const max = Math.max(1, ...counts.values())
    return [...counts.entries()]
      .map(([id, count]) => {
        const plat = platformById(id)
        return { id, count, pct: Math.round((count / max) * 100), name: plat?.name || id, dot: plat?.dot || '' }
      })
      .sort((a, b) => b.count - a.count)
  }, [safePosts])

  const byStatus = useMemo(() => {
    const total = safePosts.length || 1
    return STATUS_ROWS.map((s) => {
      const count = safePosts.filter((p) => p.status === s.key).length
      return { ...s, count, pct: Math.round((count / total) * 100) }
    })
  }, [safePosts])

  // "Up next" = the soonest dated posts still ahead of today. Anything already
  // past belongs to the calendar's history, not to a forward-looking panel.
  const upcoming = useMemo(() => {
    const today = iso(new Date())
    return safePosts
      .filter((p) => p.scheduledAt && (p.status === 'scheduled' || p.status === 'published') && p.scheduledAt >= today)
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
      .slice(0, 5)
  }, [safePosts])

  return (
    <div className="view">
      <div className="page-head">
        <span className="eyebrow">{client.name} · workspace</span>
        <h1>Everything in one <em style={{ fontStyle: 'italic', color: 'var(--rose-deep)' }}>calm</em> place.</h1>
      </div>

      {!ideasReady || !postsReady || !photosReady || !researchReady ? <DashboardSkeleton /> : (
      <>
      <div className="stats">
        <Stat num={safeIdeas.length} label="Ideas in the bank" />
        <Stat num={openTopics} label="Open topics" />
        <Stat num={scheduledCount} label="Posts scheduled" />
        <Stat num={publishedCount} label="Published" />
        <Stat num={platformsUsed} label="Channels in play" />
        <Stat num={safePhotos.length} label="Photos in library" />
        <Stat num="—" label="Avg. engagement rate" />
      </div>

      {/* grid-stretch: the two panels share a height, so an empty one holds the
          same footprint as its populated neighbour instead of collapsing. */}
      <div className="grid grid-2 grid-stretch">
        <div className="card card-pad dash-panel">
          <div className="section-head" style={{ marginTop: 0 }}>
            <div><span className="eyebrow">Up next</span><h2 style={{ marginTop: 8 }}>Coming up</h2></div>
            <button className="btn btn-ghost btn-sm" onClick={() => go('calendar')}>Calendar <Icon.Arrow className="arrow" /></button>
          </div>
          {upcoming.length === 0 ? (
            <div className="empty-state dash-empty">
              <Icon.Calendar width={20} height={20} />
              <p>Nothing scheduled ahead. Run an idea through Create to line up your next post.</p>
              <button className="btn btn-ghost btn-sm" onClick={() => go('calendar')}>Open calendar <Icon.Arrow className="arrow" /></button>
            </div>
          ) : (
            <div className="up-list">
              {upcoming.map((it) => {
                const d = prettyDate(it.scheduledAt)
                const plat = platformById(it.platform)
                return (
                  <div className="up-row" key={it.id}>
                    <div className="up-when"><div className="d">{d.d}</div><div className="m">{d.m}</div></div>
                    <div className="up-body">
                      <div className="t">{it.title || 'Untitled'}</div>
                      <div className="s">{[plat?.name || it.platform, it.format].filter(Boolean).join(' · ')}</div>
                    </div>
                    <span className={`dot ${plat?.dot || ''}`} />
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="card card-pad dash-panel">
          <div className="section-head" style={{ marginTop: 0 }}>
            <div><span className="eyebrow">Fresh ideas</span><h2 style={{ marginTop: 8 }}>From your bank</h2></div>
            <button className="btn btn-ghost btn-sm" onClick={() => go('ideas')}>All ideas <Icon.Arrow className="arrow" /></button>
          </div>
          {safeIdeas.length === 0 ? (
            <div className="empty-state dash-empty">
              <Icon.Bulb width={20} height={20} />
              <p>No ideas captured yet. Add your first in the Idea Bank.</p>
              <button className="btn btn-ghost btn-sm" onClick={() => go('ideas')}>Open Idea Bank <Icon.Arrow className="arrow" /></button>
            </div>
          ) : (
            <div className="up-list">
              {safeIdeas.slice(0, 4).map((idea) => (
                <div className="up-row" key={idea.id}>
                  <div className="up-body">
                    <div className="t">{idea.title}</div>
                    <div className="s">{(idea.tags || []).join(' · ')}</div>
                  </div>
                  <button className="btn btn-rose btn-sm" onClick={() => startFromIdea(idea)}>Create <Icon.Arrow className="arrow" /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Distribution: where the work is going and how far along it is. Both are
          derived from the same posts rows the stats above count. */}
      <div className="grid grid-2 grid-stretch" style={{ marginTop: 'var(--sp-4)' }}>
        <div className="card card-pad dash-panel">
          <div className="section-head" style={{ marginTop: 0 }}>
            <div><span className="eyebrow">Performance</span><h2 style={{ marginTop: 8 }}>Across channels</h2></div>
            <button className="btn btn-ghost btn-sm" onClick={() => go('performance')}>View all <Icon.Arrow className="arrow" /></button>
          </div>
          {!socialReady ? (
            <div className="perf-dash-rates">
              {[0, 1].map((i) => <div className="perf-dash-rate-row" key={i}><span className="perf-dash-rate-note">Loading…</span></div>)}
            </div>
          ) : liveRates.length === 0 ? (
            // No invented placeholder here: with nothing scraped there is no
            // engagement rate to show, and the fix is a refresh, not a guess.
            <div className="empty-state dash-empty">
              <Icon.BarChart width={20} height={20} />
              <p>No engagement data yet. Connect a channel in Profile, then hit Refresh on Performance.</p>
              <button className="btn btn-ghost btn-sm" onClick={() => go('performance')}>Go to Performance <Icon.Arrow className="arrow" /></button>
            </div>
          ) : (
            <div className="perf-dash-rates">
              {liveRates.map((r) => (
                <div className="perf-dash-rate-row" key={r.id}>
                  <span className="dot" style={{ background: r.color }} />
                  <span className="perf-dash-rate-name">{r.label}</span>
                  {/* The same formula on every channel, so these compare. */}
                  <span className="perf-dash-rate-note">
                    {r.followers != null
                      ? `${r.followers.toLocaleString()} ${followerWord(r.id)}`
                      : `interactions ÷ ${followerWord(r.id)}`}
                  </span>
                  <span className="perf-dash-rate-val">{fmtPct(r.rate)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card card-pad dash-panel">
          <div className="section-head" style={{ marginTop: 0 }}>
            <div><span className="eyebrow">Progress</span><h2 style={{ marginTop: 8 }}>Post status</h2></div>
            <button className="btn btn-ghost btn-sm" onClick={() => go('calendar')}>Calendar <Icon.Arrow className="arrow" /></button>
          </div>
          {safePosts.length === 0 ? (
            <div className="empty-state dash-empty">
              <Icon.Pen width={20} height={20} />
              <p>Nothing written yet. Create a post from an idea to start tracking status.</p>
            </div>
          ) : (
            <div className="meter-list">
              {byStatus.map((s) => (
                <div className="meter" key={s.key}>
                  <span className="meter-label">
                    <span className={`pill status status-${s.key}`}>{s.label}</span>
                  </span>
                  <span className="meter-track"><span className={`meter-fill fill-${s.key}`} style={{ width: `${s.pct}%` }} /></span>
                  <span className="meter-num">{s.count}</span>
                </div>
              ))}
              <p className="meter-total">{safePosts.length} post{safePosts.length === 1 ? '' : 's'} across {platformsUsed} channel{platformsUsed === 1 ? '' : 's'}</p>
            </div>
          )}
        </div>
      </div>

      {/* What's waiting to be worked on, and the assets on hand for it. */}
      <div className="grid grid-2 grid-stretch" style={{ marginTop: 'var(--sp-4)' }}>
        <div className="card card-pad dash-panel">
          <div className="section-head" style={{ marginTop: 0 }}>
            <div><span className="eyebrow">Queue</span><h2 style={{ marginTop: 8 }}>Topics to work</h2></div>
            <button className="btn btn-ghost btn-sm" onClick={() => go('research')}>Research <Icon.Arrow className="arrow" /></button>
          </div>
          {openTopicList.length === 0 ? (
            <div className="empty-state dash-empty">
              <Icon.Search width={20} height={20} />
              <p>{safeTopics.length ? 'Every topic has produced an idea. Nice.' : 'No research topics yet. Capture one to get started.'}</p>
              <button className="btn btn-ghost btn-sm" onClick={() => go('research')}>Open Research <Icon.Arrow className="arrow" /></button>
            </div>
          ) : (
            <div className="up-list">
              {openTopicList.slice(0, 4).map((t) => (
                <div className="up-row" key={t.id}>
                  <div className="up-body"><div className="t">{t.text}</div></div>
                  <button className="btn btn-rose btn-sm" onClick={() => go('research')}>Get ideas <Icon.Arrow className="arrow" /></button>
                </div>
              ))}
              {openTopicList.length > 4 && (
                <p className="meter-total">{openTopicList.length - 4} more waiting</p>
              )}
            </div>
          )}
        </div>

        <div className="card card-pad dash-panel">
          <div className="section-head" style={{ marginTop: 0 }}>
            <div><span className="eyebrow">Assets</span><h2 style={{ marginTop: 8 }}>Recent photos</h2></div>
            <button className="btn btn-ghost btn-sm" onClick={() => go('photos')}>Library <Icon.Arrow className="arrow" /></button>
          </div>
          {safePhotos.length === 0 ? (
            <div className="empty-state dash-empty">
              <Icon.Image width={20} height={20} />
              <p>No photos yet. Upload or generate images to reuse across posts.</p>
              <button className="btn btn-ghost btn-sm" onClick={() => go('photos')}>Open library <Icon.Arrow className="arrow" /></button>
            </div>
          ) : (
            <>
              <div className="mini-thumbs">
                {safePhotos.slice(0, 8).map((ph) => (
                  <button
                    className="mini-thumb"
                    key={ph.id}
                    title={`${ph.title || 'Photo'} · click to view`}
                    onClick={() => setPreviewPhoto(ph)}
                  >
                    <img src={ph.url} alt={ph.title || 'Photo'} loading="lazy" />
                    <span className="mini-thumb-zoom"><Icon.Eye width={16} height={16} /></span>
                  </button>
                ))}
              </div>
              <p className="meter-total">{safePhotos.length} image{safePhotos.length === 1 ? '' : 's'} in the library</p>
            </>
          )}
        </div>
      </div>
      </>
      )}

      {/* Bare lightbox: the image on the scrim and nothing else - no title, card,
          background, border or footer. The close button is the only chrome. */}
      {previewPhoto && (
        <Modal className="modal-lightbox" onClose={() => setPreviewPhoto(null)}>
          <img
            className="lightbox-img"
            src={previewPhoto.url}
            alt={previewPhoto.title || 'Photo'}
          />
        </Modal>
      )}
    </div>
  )
}
