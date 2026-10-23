import { useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Icon } from '../icons.jsx'
import { Modal } from '../components/Modal.jsx'
import { PostPreview } from '../components/PostPreview.jsx'
import { DatePicker } from '../components/DatePicker.jsx'
import { PLATFORMS, VISUAL_PATHS, platformById, pickImagePrompt, graphicPromptFor, pickAiImage } from '../data.js'
import { DOW, MONTHS, iso, addDays, dotColor, uid } from '../lib/util.js'

// Posts shown per day before the cell collapses the rest behind "+n more".
// Without a cap a single busy day stretched its whole week to ~400px and the
// month ran several screens long.
const MAX_PER_DAY = 3
// A single week row has far more vertical room than a month cell.
const MAX_PER_WEEK_DAY = 8

const VIEWS = [
  { id: 'month', label: 'Month' },
  { id: 'week', label: 'Week' },
  { id: 'day', label: 'Day' },
  { id: 'custom', label: 'Custom' },
]

// `scheduled_at` is a timestamptz, so it comes back as
// "2026-07-29T14:30:00+00:00". Both helpers read the stored wall-clock straight
// off the string rather than converting through a local Date: the app writes the
// time the user typed, Postgres stores it at +00:00, and reading the same digits
// back gives that time again. Converting to local would shift both the time and
// (for negative offsets) the day the post lands on.
const dateOf = (v) => String(v || '').slice(0, 10)
const timeOf = (v) => {
  const m = String(v || '').match(/T(\d{2}):(\d{2})/)
  if (!m) return ''
  // Every legacy row is stored at exactly midnight, meaning "this day, no
  // particular time" - showing "12am" on all of them was just noise.
  if (m[1] === '00' && m[2] === '00') return ''
  const h = Number(m[1])
  const suffix = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}${m[2] === '00' ? '' : ':' + m[2]}${suffix}`
}

// Parse a yyyy-mm-dd key as a LOCAL date. `new Date('2026-07-29')` is parsed as
// UTC midnight, which lands on the previous day in any negative-offset zone.
const parseKey = (k) => {
  const [y, m, d] = k.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const shiftKey = (k, n) => iso(addDays(parseKey(k), n))
const longDate = (k) => {
  const d = parseKey(dateOf(k))
  return `${DOW[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}
// full "date at time" label, falling back to date-only when no time is stored
const whenLabel = (v) => {
  const t = timeOf(v)
  return t ? `${longDate(v)} at ${t}` : longDate(v)
}
// "Jul 26 – Aug 1, 2026" for the week heading, collapsing the month when both
// ends fall inside it
const weekLabel = (k) => {
  const start = addDays(parseKey(k), -parseKey(k).getDay())
  const end = addDays(start, 6)
  const sm = MONTHS[start.getMonth()].slice(0, 3)
  const em = MONTHS[end.getMonth()].slice(0, 3)
  const left = `${sm} ${start.getDate()}`
  const right = start.getMonth() === end.getMonth() ? `${end.getDate()}` : `${em} ${end.getDate()}`
  return `${left} – ${right}, ${end.getFullYear()}`
}

// Day and Custom views share one agenda list: date heading, then that day's
// posts. Empty days are skipped in a range but shown explicitly for a single day.
function Agenda({ groups, todayKey, onOpen, emptyLabel }) {
  if (groups.length === 0) {
    return (
      <div className="card empty-state">
        <Icon.Calendar width={20} height={20} />
        <p>{emptyLabel}</p>
      </div>
    )
  }
  return (
    <div className="card agenda">
      {groups.map((g) => (
        <section className="agenda-day" key={g.key}>
          <header className="agenda-date">
            <span className="agenda-date-label">{longDate(g.key)}</span>
            {g.key === todayKey && <span className="pill rose">Today</span>}
            <span className="agenda-count">{g.events.length} post{g.events.length === 1 ? '' : 's'}</span>
          </header>
          {g.events.length === 0 ? (
            <p className="agenda-empty">Nothing scheduled on this day.</p>
          ) : g.events.map((ev) => {
            const p = platformById(ev.platform)
            const published = ev.status === 'published'
            return (
              <button className="agenda-row" key={ev.id} onClick={() => onOpen(ev)}>
                <span className="agenda-accent" style={{ background: dotColor(p?.dot) }} />
                <span className="agenda-main">
                  <span className="agenda-title">{ev.title}</span>
                  <span className="agenda-meta">{[timeOf(ev.scheduledAt), p?.name || ev.platform, ev.format].filter(Boolean).join(' · ')}</span>
                </span>
                <span className={`pill status status-${published ? 'published' : 'scheduled'}`}>
                  {published ? 'Published' : 'Scheduled'}
                </span>
              </button>
            )
          })}
        </section>
      ))}
    </div>
  )
}

export default function CalendarPage() {
  const { client, posts, updatePost, removePost, savePostBatch, photos, flash } = useOutletContext()
  const today = new Date()
  const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() })
  const [selected, setSelected] = useState(null)
  const [editing, setEditing] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [postImgIdx, setPostImgIdx] = useState(0)
  const [form, setForm] = useState(null)
  const [confirmTarget, setConfirmTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const fullDate = (isoStr) => {
    const [y, m, d] = isoStr.split('-').map(Number)
    return `${MONTHS[m - 1]} ${d}, ${y}`
  }

  // --- drag to reschedule -----------------------------------------------------
  // A post can be dragged onto any day from today onwards. Past days never accept
  // a drop: scheduling into the past would mean a post that can never publish,
  // and the DatePicker already refuses past dates, so the calendar matches it.
  const todayKey = iso(today)
  const [dragId, setDragId] = useState(null)
  const [dropKey, setDropKey] = useState(null)   // cell currently under the cursor
  const [moving, setMoving] = useState(false)
  const [expanded, setExpanded] = useState(null) // day key showing all its posts

  const isPast = (key) => key < todayKey
  const canDropOn = (key) => Boolean(dragId) && !isPast(key)

  // --- month / day / custom ---------------------------------------------------
  const [view, setView] = useState('month')
  const [dayKey, setDayKey] = useState(todayKey)
  const [weekKey, setWeekKey] = useState(todayKey)
  const [range, setRange] = useState({ from: todayKey, to: shiftKey(todayKey, 13) })

  // Keep the range ordered whichever end the user edits.
  const setFrom = (v) => setRange((r) => ({ from: v, to: r.to < v ? v : r.to }))
  const setTo = (v) => setRange((r) => ({ from: v < r.from ? v : r.from, to: v }))

  // Some browsers fire a click on the source element right after a drop, which
  // would open the detail modal on top of the reschedule the user just made.
  const dragEndedAt = useRef(0)
  const endDrag = () => { dragEndedAt.current = Date.now(); setDragId(null); setDropKey(null) }
  const justDragged = () => Date.now() - dragEndedAt.current < 250

  const onDropDay = async (key) => {
    const id = dragId
    endDrag()
    if (!id || isPast(key)) return
    const post = (posts || []).find((p) => p.id === id)
    if (!post || dateOf(post.scheduledAt) === key) return
    // carry the existing time across, so a reschedule only changes the day
    const timePart = String(post.scheduledAt || '').slice(10)
    setMoving(true)
    try {
      await updatePost(id, { scheduledAt: key + timePart })
      flash(`Moved to ${fullDate(key)}`)
    } catch {
      flash('Could not move the post')
    } finally {
      setMoving(false)
    }
  }

  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1)
    const startPad = first.getDay()
    const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate()
    const out = []
    for (let i = 0; i < startPad; i++) out.push(null)
    for (let d = 1; d <= daysInMonth; d++) out.push(new Date(cursor.y, cursor.m, d))
    while (out.length % 7 !== 0) out.push(null)
    return out
  }, [cursor])

  const eventsByDay = useMemo(() => {
    const map = {}
    if (!posts) return map
    posts.forEach((p) => {
      if ((p.status === 'scheduled' || p.status === 'published') && p.scheduledAt) {
        const dayKeyFor = dateOf(p.scheduledAt)
        const mappedPhotoIds = (p.imagePaths || []).map(url => photos.find(ph => ph.url === url)?.id).filter(Boolean)
        const visual = p.imagePaths?.length
          ? { path: 'photo', photoIds: mappedPhotoIds, src: p.imagePaths[0], prompt: p.imagePrompt || '' }
          : { path: null, photoIds: [], src: '', prompt: p.imagePrompt || '' }

        const ev = {
          ...p,
          id: p.id,
          date: p.scheduledAt,
          platform: p.platform,
          title: p.title || 'Untitled',
          body: p.content || '',
          hashtags: (p.tags || []).map(t => `#${t}`).join(' '),
          status: p.status,
          format: p.format || '',
          visual,
        }
          ; (map[dayKeyFor] ||= []).push(ev)
      }
    })
    return map
  }, [posts, photos])

  // Day view: one group, rendered even when empty so the date still reads.
  // Custom view: every day in the range that actually has posts.
  // Declared after eventsByDay - it reads from it.
  const agendaGroups = useMemo(() => {
    if (view === 'day') return [{ key: dayKey, events: eventsByDay[dayKey] || [] }]
    if (view !== 'custom') return []
    const out = []
    let k = range.from
    // hard stop so a very wide range can't spin
    for (let i = 0; k <= range.to && i < 400; i++, k = shiftKey(k, 1)) {
      const events = eventsByDay[k] || []
      if (events.length) out.push({ key: k, events })
    }
    return out
  }, [view, dayKey, range, eventsByDay])

  // Week view reuses the month grid, just seven cells and taller rows.
  const weekCells = useMemo(() => {
    const start = addDays(parseKey(weekKey), -parseKey(weekKey).getDay()) // back to Sunday
    return Array.from({ length: 7 }, (_, i) => addDays(start, i))
  }, [weekKey])

  const move = (delta) => {
    let m = cursor.m + delta, y = cursor.y
    if (m < 0) { m = 11; y-- }
    if (m > 11) { m = 0; y++ }
    setCursor({ y, m })
  }

  // Shared day-cell renderer for the month and week grids: same drag targets,
  // same chips, same "+n more" behaviour. Week cells show more before collapsing
  // because there's far more vertical room in a single row.
  const perDay = view === 'week' ? MAX_PER_WEEK_DAY : MAX_PER_DAY
  const renderCell = (d, i) => {
    if (!d) return <div className="cal-cell blank" key={i} />
    const key = iso(d)
    const isToday = key === todayKey
    const past = isPast(key)
    const evs = eventsByDay[key] || []
    const open = expanded === key
    const shown = open ? evs : evs.slice(0, perDay)
    const hidden = evs.length - shown.length
    const cls = [
      'cal-cell',
      isToday && 'today',
      past && 'past',
      [0, 6].includes(d.getDay()) && 'weekend',
      dropKey === key && 'drop-target',
      dragId && past && 'drop-blocked',
    ].filter(Boolean).join(' ')
    return (
      <div
        className={cls}
        key={i}
        onDragOver={(e) => {
          if (!canDropOn(key)) return   // no preventDefault → drop is refused
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          if (dropKey !== key) setDropKey(key)
        }}
        onDragLeave={(e) => {
          // dragleave also fires when the cursor crosses onto a child post chip;
          // ignore those or the highlight flickers
          if (e.currentTarget.contains(e.relatedTarget)) return
          setDropKey((k) => (k === key ? null : k))
        }}
        onDrop={(e) => { e.preventDefault(); onDropDay(key) }}
      >
        <span className="daynum">
          {d.getDate()}
          {view === 'week' && <em className="daynum-mon">{MONTHS[d.getMonth()].slice(0, 3)}</em>}
        </span>

        <div className="cal-events">
          {shown.map((ev) => {
            const p = platformById(ev.platform)
            const isPublished = ev.status === 'published'
            const at = timeOf(ev.scheduledAt)
            return (
              <div
                className={`cal-event ${isPublished ? 'published' : ''} ${dragId === ev.id ? 'dragging' : ''}`}
                key={ev.id}
                style={{ '--ev-accent': dotColor(p?.dot) }}
                title={`${p?.name || ev.platform} · ${ev.title}\n${whenLabel(ev.scheduledAt)} · ${isPublished ? 'Published' : 'Scheduled'} · drag to reschedule`}
                draggable
                onDragStart={(e) => {
                  setDragId(ev.id)
                  e.dataTransfer.effectAllowed = 'move'
                  try { e.dataTransfer.setData('text/plain', ev.id) } catch { /* Safari */ }
                }}
                onDragEnd={endDrag}
                onClick={() => { if (!justDragged()) openPost(ev) }}
              >
                {/* One line: the platform reads from the dot, the coloured left
                    border and the legend above, so spelling it out here cost
                    15px of height on every chip. */}
                <span className={`dot ${p?.dot || ''}`} />
                {at && <span className="ev-time">{at}</span>}
                <span className="ev-title">
                  {isPublished && <span className="ev-published" aria-label="Published">✓ </span>}
                  {ev.title}
                </span>
              </div>
            )
          })}
        </div>

        {hidden > 0 && (
          <button className="cal-more" onClick={() => setExpanded(key)}>+{hidden} more</button>
        )}
        {open && evs.length > perDay && (
          <button className="cal-more" onClick={() => setExpanded(null)}>Show less</button>
        )}
      </div>
    )
  }

  const openPost = (ev) => { setSelected(ev); setEditing(false); setPreviewing(false); setPostImgIdx(0) }
  const closePost = () => { setSelected(null); setEditing(false); setPreviewing(false); setPostImgIdx(0) }
  const confirmDelete = async () => {
    if (!confirmTarget || deleting) return
    setDeleting(true)
    try {
      await removePost(confirmTarget.id)
      flash('Removed from calendar')
      closePost()
    } catch (e) {
      flash('Could not remove post')
    }
    setDeleting(false)
    setConfirmTarget(null)
  }
  const startEdit = () => {
    setForm({
      title: selected.title,
      // date and time are edited separately, then recombined on save
      date: dateOf(selected.date),
      // "2026-07-29T14:30:00+00:00" -> "14:30"; midnight reads as no time set
      time: (String(selected.scheduledAt || '').slice(11, 16) === '00:00'
        ? '' : String(selected.scheduledAt || '').slice(11, 16)),
      body: selected.body || '',
      hashtags: (selected.tags || []).join(', '),
      visual: selected.visual || { path: null, photoIds: [], prompt: '', src: '' }
    })
    setEditing(true)
  }
  const saveEdit = async () => {
    const patch = {
      title: form.title.trim() || 'Untitled',
      content: form.body,
      tags: [...new Set(form.hashtags.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean))],
      // "2026-07-29" or "2026-07-29T14:30" depending on whether a time is set
      scheduledAt: form.time ? `${dateOf(form.date)}T${form.time}` : dateOf(form.date),
      imagePaths: form.visual?.photoIds?.map(id => photos.find(ph => ph.id === id)?.url).filter(Boolean) || [],
      imagePrompt: form.visual?.prompt || ''
    }
    try {
      await updatePost(selected.id, patch)
      flash('Post updated')
      closePost()
    } catch (e) {
      flash('Could not update the post')
    }
  }
  const duplicate = async () => {
    try {
      const dupRow = {
        platform: selected.platform,
        title: selected.title + ' (Copy)',
        content: selected.content,
        note: selected.note,
        format: selected.format,
        tags: selected.tags,
        imagePaths: selected.imagePaths,
        imagePrompt: selected.imagePrompt,
        scheduledAt: selected.date,
      }
      await savePostBatch(uid('dup'), [dupRow], 'scheduled')
      flash('Post duplicated')
      closePost()
    } catch (e) {
      flash('Could not duplicate post')
    }
  }
  const publish = async () => {
    try {
      await updatePost(selected.id, { status: 'published' })
      flash('Marked as published')
      closePost()
    } catch (e) {
      flash('Could not publish post')
    }
  }

  return (
    <div className="view">
      <div className="page-head">
        <span className="eyebrow">Calendar</span>
        <h1>Content Calendar</h1>
        <p className="lede">Everything scheduled or published, by date. Click a post to open its details.</p>
      </div>

      <div className="cal-toolbar">
        <div className="cal-views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`cal-view-btn ${view === v.id ? 'on' : ''}`}
              onClick={() => setView(v.id)}
            >{v.label}</button>
          ))}
        </div>

        {view === 'month' && (
          <div className="cal-month">
            <h2>{MONTHS[cursor.m]} {cursor.y}</h2>
            <div className="cal-nav">
              <button onClick={() => move(-1)} aria-label="Previous month"><Icon.Chevron width={15} height={15} style={{ transform: 'rotate(180deg)' }} /></button>
              <button className="cal-today-btn" onClick={() => setCursor({ y: today.getFullYear(), m: today.getMonth() })}>Today</button>
              <button onClick={() => move(1)} aria-label="Next month"><Icon.Chevron width={15} height={15} /></button>
            </div>
          </div>
        )}

        {view === 'week' && (
          <div className="cal-month">
            <h2>{weekLabel(weekKey)}</h2>
            <div className="cal-nav">
              <button onClick={() => setWeekKey((k) => shiftKey(k, -7))} aria-label="Previous week"><Icon.Chevron width={15} height={15} style={{ transform: 'rotate(180deg)' }} /></button>
              <button className="cal-today-btn" onClick={() => setWeekKey(todayKey)}>This week</button>
              <button onClick={() => setWeekKey((k) => shiftKey(k, 7))} aria-label="Next week"><Icon.Chevron width={15} height={15} /></button>
            </div>
          </div>
        )}

        {view === 'day' && (
          <div className="cal-month">
            <h2>{MONTHS[parseKey(dayKey).getMonth()]} {parseKey(dayKey).getDate()}, {parseKey(dayKey).getFullYear()}</h2>
            <div className="cal-nav">
              <button onClick={() => setDayKey((k) => shiftKey(k, -1))} aria-label="Previous day"><Icon.Chevron width={15} height={15} style={{ transform: 'rotate(180deg)' }} /></button>
              <button className="cal-today-btn" onClick={() => setDayKey(todayKey)}>Today</button>
              <button onClick={() => setDayKey((k) => shiftKey(k, 1))} aria-label="Next day"><Icon.Chevron width={15} height={15} /></button>
            </div>
          </div>
        )}

        {view === 'custom' && (
          <div className="cal-range">
            <span className="cal-range-field">
              <span className="mini-label">From</span>
              <DatePicker value={range.from} onChange={setFrom} />
            </span>
            <span className="cal-range-sep">–</span>
            <span className="cal-range-field">
              <span className="mini-label">To</span>
              {/* min = the From date, so the range can't be inverted. Previously
                  picking an earlier To silently dragged From back with it, which
                  looked like the picker changing the wrong field. */}
              <DatePicker value={range.to} onChange={setTo} min={range.from} />
            </span>
          </div>
        )}

        <span className="cal-hint">
          {moving ? 'Moving…'
            : (view === 'month' || view === 'week') ? 'Drag a post to another day to reschedule it'
            : `${agendaGroups.reduce((n, g) => n + g.events.length, 0)} post${agendaGroups.reduce((n, g) => n + g.events.length, 0) === 1 ? '' : 's'} in view`}
        </span>
        <div className="cal-legend">{PLATFORMS.map((p) => <span className="cal-legend-item" key={p.id}><span className={`dot ${p.dot}`} />{p.name}</span>)}</div>
      </div>

      {view !== 'month' && view !== 'week' ? (
        <Agenda
          groups={agendaGroups}
          todayKey={todayKey}
          onOpen={openPost}
          emptyLabel={view === 'day'
            ? 'Nothing scheduled on this day.'
            : 'No posts scheduled in this range. Widen the dates or pick another period.'}
        />
      ) : (
      <div className={`calendar ${dragId ? 'is-dragging' : ''}`}>
        <div className="cal-dow">{DOW.map((d) => <div key={d}>{d}</div>)}</div>
        <div className={`cal-grid ${view === 'week' ? 'cal-grid-week' : ''}`}>
          {(view === 'week' ? weekCells : cells).map(renderCell)}
        </div>
      </div>
      )}

      {selected && (() => {
        const p = platformById(selected.platform)

        /* ----- edit mode ----- */
        if (editing) {
          const fv = form.visual || { path: null, photoIds: [], prompt: '', src: '' }
          const setFormVisual = (v) => setForm((f) => ({ ...f, visual: v }))
          const pickEditVisual = (pathId) => {
            if (pathId === 'ai') setFormVisual({ path: 'ai', photoIds: [], prompt: pickImagePrompt(selected.title), src: pickAiImage(selected.title + selected.platform) })
            else if (pathId === 'graphic') setFormVisual({ path: 'graphic', photoIds: [], prompt: graphicPromptFor(selected.title), src: '' })
            else setFormVisual({ path: 'photo', photoIds: [], prompt: '', src: '' })
          }
          const toggleEditPhoto = (photoId) => {
            const v = fv.path === 'photo' ? fv : { path: 'photo', photoIds: [], prompt: '', src: '' }
            const has = v.photoIds?.includes(photoId)
            const photoIds = has ? v.photoIds.filter((x) => x !== photoId) : [...(v.photoIds || []), photoId]
            setFormVisual({ ...v, path: 'photo', photoIds })
          }
          return (
            <Modal title="Edit post" sub={`${p?.name} · ${selected.format}`} onClose={closePost}>
              <div className="stack">
                <div><span className="label">Title</span><input className="field" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
                <div className="when-row">
                  <div><span className="label">Publish date</span><DatePicker value={dateOf(form.date)} onChange={(v) => setForm({ ...form, date: v })} disablePast /></div>
                  <div>
                    <span className="label">Time <span className="muted-text">(optional)</span></span>
                    <input
                      className="field"
                      type="time"
                      value={form.time}
                      onChange={(e) => setForm({ ...form, time: e.target.value })}
                    />
                  </div>
                </div>
                <div><span className="label">Content</span><textarea className="field" style={{ minHeight: 150, lineHeight: 1.6 }} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></div>
                <div><span className="label">Hashtags</span><input className="field" value={form.hashtags} onChange={(e) => setForm({ ...form, hashtags: e.target.value })} /></div>

                <div>
                  <span className="label">Visual</span>
                  <div className="chip-row" style={{ marginBottom: 12 }}>
                    {VISUAL_PATHS.map((vp) => (
                      <button key={vp.id} className={`chip ${fv.path === vp.id ? 'on' : ''}`} onClick={() => pickEditVisual(vp.id)}>{vp.name}</button>
                    ))}
                  </div>
                  {fv.path === 'photo' && (
                    <>
                      <span className="check-progress">{fv.photoIds?.length || 0} selected{fv.photoIds?.length > 1 ? ' · carousel' : ''}</span>
                      <div className="photo-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginTop: 8 }}>
                        {photos.map((ph) => {
                          const idx = fv.photoIds?.indexOf(ph.id) ?? -1
                          const sel = idx >= 0
                          return (
                            <button key={ph.id} className={`photo photo-pick ${sel ? 'sel' : ''}`} onClick={() => toggleEditPhoto(ph.id)}>
                              {ph.url ? <img src={ph.url} alt={ph.title} /> : <span className="swatch" style={{ background: ph.swatch }} />}
                              {sel && <span className="pick-order">{idx + 1}</span>}
                            </button>
                          )
                        })}
                      </div>
                    </>
                  )}
                  {fv.path === 'ai' && <div className="ai-result" style={{ marginTop: 4 }}><img src={fv.src} alt="AI preview" /></div>}
                  {fv.path === 'graphic' && <div className="imageprompt" style={{ marginTop: 4 }}><p>{fv.prompt}</p></div>}
                </div>
              </div>
              <div className="modal-actions modal-actions-sticky modal-actions-split">
                <button className="btn btn-danger" onClick={() => setConfirmTarget(selected)}>Delete</button>
                <span className="row" style={{ gap: 10 }}>
                  <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
                  <button className="btn btn-primary" onClick={saveEdit}>Save changes</button>
                </span>
              </div>
            </Modal>
          )
        }

        /* ----- preview mode (realistic platform render) ----- */
        if (previewing) {
          return (
            <Modal wide title="Post preview" sub={`${p?.name} · ${selected.format}`} onClose={closePost}>
              <div style={{ marginBottom: 16 }}>
                <button className="btn btn-ghost" onClick={() => setPreviewing(false)}><Icon.Back /> Back</button>
              </div>
              <PostPreview client={client} platform={selected.platform} format={selected.format} draft={{ body: selected.body, hashtags: selected.hashtags }} visual={selected.visual} photos={photos} topic={selected.title} />
            </Modal>
          )
        }

        /* ----- view mode ----- */
        const vpath = selected.visual?.path
        const vPhotoIds = selected.visual?.photoIds || (selected.visual?.photoId ? [selected.visual.photoId] : [])
        const count = vPhotoIds.length
        const safeIdx = count ? Math.min(postImgIdx, count - 1) : 0
        const photo = vPhotoIds[safeIdx] ? photos.find((ph) => ph.id === vPhotoIds[safeIdx]) : null
        // If there are photos attached, use the currently indexed photo's url/src. Otherwise fallback to the static AI visual src.
        const imgSrc = count > 0 ? (photo?.url || photo?.src) : selected.visual?.src
        const vLabel = vpath === 'photo' ? (count > 1 ? `Your photos (${count})` : 'Your own photo') : vpath === 'ai' ? 'AI image / video' : vpath === 'graphic' ? 'Text-based graphic' : null
        const hasVisual = imgSrc || photo || selected.imagePrompt || vpath
        const go = (d) => setPostImgIdx(() => (count ? (safeIdx + d + count) % count : 0))

        return (
          <Modal wide={hasVisual} title={selected.title} sub={`${p?.name} · ${selected.format} · ${fullDate(selected.date)}`} onClose={closePost}>
            <div className={`post-detail ${hasVisual ? '' : 'solo'}`}>
              {hasVisual && (
                <div className="pd-col">
                  <span className="label">Visual{vLabel ? ` · ${vLabel}` : ''}</span>
                  <div className="post-visual" style={{ position: 'relative' }}>
                    {imgSrc ? <img src={imgSrc} alt={photo?.title || 'visual'} />
                      : photo?.swatch ? <span className="swatch" style={{ background: photo.swatch }} />
                        : <div className="visual-ph">{vpath === 'ai' ? <Icon.Spark width={22} height={22} /> : <Icon.Layers width={22} height={22} />}<span>{vLabel || 'Visual'}</span><small>Preview - from the prompt below</small></div>}

                    {count > 1 && (
                      <>
                        <span className="lp-carousel">{safeIdx + 1}/{count}</span>
                        <button className="lp-nav prev" onClick={() => go(-1)} aria-label="Previous image">‹</button>
                        <button className="lp-nav next" onClick={() => go(1)} aria-label="Next image">›</button>
                      </>
                    )}
                    {photo?.title && <span className="post-visual-cap">{photo.title}</span>}
                  </div>
                  {selected.imagePrompt && <div className="imageprompt" style={{ marginTop: 12 }}><p>{selected.imagePrompt}</p></div>}
                </div>
              )}
              <div className="pd-col">
                <span className="label">Content</span>
                <div className="review-box pd-box">
                  {selected.body
                    ? <>{selected.body}{selected.hashtags && <div className="hashline">{selected.hashtags}</div>}</>
                    : <span className="muted-text">No draft saved for this post (it was added before content was written). Hit Edit to add it.</span>}
                </div>
              </div>
            </div>

            <div className="modal-actions modal-actions-sticky modal-actions-split wrap">
              <button className="btn btn-danger" onClick={() => setConfirmTarget(selected)}>Delete</button>
              <span className="row wrap" style={{ gap: 10 }}>
                <button className="btn btn-ghost" onClick={() => setPreviewing(true)}><Icon.Eye width={15} height={15} /> Preview</button>
                <button className="btn btn-ghost" onClick={duplicate}><Icon.Copy /> Duplicate</button>
                <button className="btn btn-ghost" onClick={startEdit}><Icon.Pen width={15} height={15} /> Edit</button>
                {selected.status === 'published'
                  ? <span className="pill status status-published">Published</span>
                  : <button className="btn btn-primary" onClick={publish}>Mark as published</button>}
              </span>
            </div>
          </Modal>
        )
      })()}

      {confirmTarget && (
        <Modal title="Delete this post?" onClose={() => !deleting && setConfirmTarget(null)}>
          <div className="confirm-body">
            <span className="confirm-icon"><Icon.Trash width={20} height={20} /></span>
            <p className="confirm-text">
              <strong>“{confirmTarget.title || 'This post'}”</strong> will be permanently removed. This can’t be undone.
            </p>
          </div>
          <div className="modal-actions" style={{ marginTop: 24, justifyContent: 'flex-end', display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" onClick={() => setConfirmTarget(null)} disabled={deleting}>Cancel</button>
            <button className="btn btn-danger" onClick={confirmDelete} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete post'}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
