import { useState, useEffect, useCallback, useMemo } from 'react'
import { useOutletContext } from 'react-router-dom'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '../icons.jsx'
import { Modal } from '../components/Modal.jsx'
import { ResearchListSkeleton } from '../components/Skeleton.jsx'
import { platformById } from '../data.js'
import { listResearchTopics, generateStreamTopics, deleteResearchTopic } from '../api.js'

// Rows-per-page options — stream defaults to 5 (the hard cap); Manual matches
// Idea Bank / Posts with a larger first option.
const PAGE_SIZES = [10, 25, 50]
const STREAM_PAGE_SIZES = [5, 10, 25]

// Short "when was this captured" label for a topic row.
const fmtWhen = (isoStr) => {
  if (!isoStr) return ''
  try { return new Date(isoStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }
  catch { return '' }
}

// Tab-panel swap: blur + slide + fade, matching the brand-brain editor's feel.
const panelV = {
  hidden: { opacity: 0, y: 14, filter: 'blur(8px)' },
  show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.36, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, y: -12, filter: 'blur(8px)', transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } },
}

// Fold suggest angle/pillar into the Idea Bank note so Generate can recover them
// without a DB migration. Marker is parsed in GeneratePostModal.
function ideaFromSuggestion(idea) {
  const angle = (idea.angle || idea.description || '').trim()
  const parts = [angle]
  if (idea.pillar) parts.push(`[Pillar: ${idea.pillar}]`)
  if (idea.sourceUrl) parts.push(`Source: ${idea.sourceUrl}`)
  const tags = [...(idea.tags || [])]
  if (idea.pillar && !tags.some((t) => t.toLowerCase() === idea.pillar.toLowerCase())) tags.push(idea.pillar)
  return {
    title: idea.title,
    note: parts.filter(Boolean).join('\n\n'),
    tags,
    platforms: idea.platform ? [idea.platform] : ['linkedin'],
  }
}

// Stream topics are stored as "headline [domain](url)". Split the headline from
// its trailing markdown source link so the row can show the headline on top and
// the source on its own line below, labelled "Source:".
function parseTopic(text) {
  const str = String(text || '').trim()
  const m = str.match(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\s*$/)
  if (m) return { text: str.slice(0, m.index).trim(), source: { label: m[1], url: m[2] } }
  return { text: str, source: null }
}

// Bulk-selection state shared by both research tabs. `allIds` is the set of ids
// currently eligible (filtered rows in Manual, all rows in Stream); "select all"
// spans them even across pagination so the user can wipe everything at once.
function useBulkSelect(allIds) {
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const toggle = (id) => setSelected((s) => {
    const n = new Set(s)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })
  const clear = () => setSelected(new Set())
  const enter = () => { clear(); setSelectMode(true) }
  const exit = () => { clear(); setSelectMode(false) }
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(allIds))
  return { selectMode, selected, toggle, clear, enter, exit, allSelected, toggleAll }
}

// The action bar shown while in select mode: select-all, live count, delete, cancel.
function BulkToolbar({ count, allSelected, onToggleAll, onDelete, onCancel, deleting }) {
  return (
    <div className="bulk-bar">
      <label className="bulk-check-label">
        <input type="checkbox" className="research-check" checked={allSelected} onChange={onToggleAll} />
        Select all
      </label>
      <span className="bulk-spacer" />
      <span className="bulk-count">{count} selected</span>
      <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={deleting}>Cancel</button>
      <button className="btn btn-danger btn-sm" onClick={onDelete} disabled={!count || deleting}>
        <Icon.Trash width={14} height={14} /> {deleting ? 'Deleting…' : `Delete ${count}`}
      </button>
    </div>
  )
}

// Suggestion modal: on open, asks the AI for 2-3 ideas from the topic. The user
// picks one → the parent saves it to the Idea Bank and marks the topic done.
function SuggestModal({ topic, suggest, onChoose, onClose }) {
  const [status, setStatus] = useState('loading') // loading | ready | error
  const [ideas, setIdeas] = useState([])
  const [error, setError] = useState('')
  const [addingIdx, setAddingIdx] = useState(null)

  const run = useCallback(async () => {
    setStatus('loading')
    setError('')
    try {
      const list = await suggest(topic.id)
      if (!list.length) {
        setError('No ideas came back for this topic - try again.')
        setStatus('error')
        return
      }
      setIdeas(list)
      setStatus('ready')
    } catch (e) {
      setError(e.message || 'Could not generate ideas')
      setStatus('error')
    }
  }, [suggest, topic.id])

  useEffect(() => { run() }, [run])

  const choose = async (idea, idx) => {
    if (addingIdx !== null) return
    setAddingIdx(idx)
    try {
      await onChoose(idea) // parent saves + marks done + closes (unmounts us)
    } catch {
      setAddingIdx(null) // stay open so the user can retry or pick another
    }
  }

  return (
    <Modal title="AI idea suggestions" sub={`From your research topic: “${topic.text}”`} onClose={onClose} wide>
      {status === 'loading' && (
        <div className="suggest-state">
          <span className="suggest-spinner" />
          <p>Searching the web for the latest on this topic & shaping ideas…</p>
        </div>
      )}

      {status === 'error' && (
        <div className="suggest-state">
          <p className="suggest-error">{error}</p>
          <button className="btn btn-rose btn-sm" onClick={run}><Icon.Spark width={14} height={14} /> Try again</button>
        </div>
      )}

      {status === 'ready' && (
        <div className="suggest-list">
          {ideas.map((idea, i) => {
            const p = platformById(idea.platform)
            return (
              <div className="suggest-card" key={i}>
                <div className="suggest-card-main">
                  <h4>{idea.title}</h4>
                  {idea.description && <p style={{ whiteSpace: 'pre-wrap' }}>{idea.description}</p>}
                  {(idea.angle || idea.pillar) && (
                    <p style={{ marginTop: 6, fontSize: 13 }} className="muted-text">
                      {idea.pillar ? <><strong>Pillar:</strong> {idea.pillar}{idea.angle ? ' · ' : ''}</> : null}
                      {idea.angle ? <><strong>Angle:</strong> {idea.angle}</> : null}
                    </p>
                  )}
                  {idea.sourceUrl && (
                    <p style={{ marginTop: 6, fontSize: 13 }}>
                      <span className="muted-text">Source: </span>
                      <a href={idea.sourceUrl} target="_blank" rel="noreferrer" className="link-btn" style={{ wordBreak: 'break-all' }}>{idea.sourceUrl}</a>
                    </p>
                  )}
                  <div className="suggest-meta">
                    {p && <span className="pill"><span className={`dot ${p.dot}`} /> {p.name}</span>}
                    {idea.tags?.map((t) => <span className="pill" key={t}>{t}</span>)}
                  </div>
                </div>
                <button className="btn btn-primary btn-sm suggest-use" disabled={addingIdx !== null} onClick={() => choose(idea, i)}>
                  {addingIdx === i ? 'Adding…' : <>Use this <Icon.Arrow className="arrow" /></>}
                </button>
              </div>
            )
          })}
          <p className="muted-text" style={{ fontSize: 12 }}>Picking one saves it to the Idea Bank and marks this research topic done.</p>
        </div>
      )}
    </Modal>
  )
}

// Manual tab: capture research topics by name (persisted in the DB, scoped to
// the client). Each topic can spin up AI idea suggestions via the modal.
function ManualTab({ topics, ready, addTopic, removeTopic, editTopic, suggest, addIdea, markDone, flash }) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [modalTopic, setModalTopic] = useState(null)
  const [editing, setEditing] = useState(null) // topic open in the view/edit modal
  const [editText, setEditText] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState(null) // topic pending delete confirmation
  const [deleting, setDeleting] = useState(false)

  // --- Search / sort / pagination state ---
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('newest') // newest | oldest | az | za
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])

  // Filter by text, then order. createdAt is an ISO string, so lexical compare works.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = q ? topics.filter((t) => (t.text || '').toLowerCase().includes(q)) : [...topics]
    rows.sort((a, b) => {
      if (sort === 'az') return (a.text || '').localeCompare(b.text || '')
      if (sort === 'za') return (b.text || '').localeCompare(a.text || '')
      const cmp = String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      return sort === 'oldest' ? cmp : -cmp
    })
    return rows
  }, [topics, search, sort])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize)
  useEffect(() => { setPage((p) => Math.min(p, totalPages)) }, [totalPages])
  useEffect(() => { setPage(1) }, [search, sort, pageSize])

  // --- bulk select / delete ---
  const bulk = useBulkSelect(filtered.map((t) => t.id))
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  // A search change alters which rows exist, so drop any stale selection.
  useEffect(() => { bulk.clear() }, [search]) // eslint-disable-line react-hooks/exhaustive-deps

  // Delete every selected topic. removeTopic is optimistic and updates the parent
  // list; run sequentially so each call sees the already-trimmed list.
  const bulkDelete = async () => {
    if (bulkDeleting) return
    setBulkDeleting(true)
    const ids = [...bulk.selected]
    for (const id of ids) await removeTopic(id)
    setBulkDeleting(false)
    setConfirmBulk(false)
    bulk.exit()
    flash(`Deleted ${ids.length} topic${ids.length > 1 ? 's' : ''}`)
  }

  const add = async () => {
    const t = text.trim()
    if (!t || saving) return
    setSaving(true)
    try {
      await addTopic(t)
      setText('')
    } catch (e) {
      flash(e.message || 'Could not save the topic')
    } finally {
      setSaving(false)
    }
  }

  // Delete is confirmed through a modal first (removeTopic is optimistic +
  // rolls back on failure, so awaiting here just lets the button show progress).
  const confirmDelete = async () => {
    if (!confirmTarget || deleting) return
    setDeleting(true)
    await removeTopic(confirmTarget.id)
    setDeleting(false)
    setConfirmTarget(null)
  }

  const openEdit = (t) => { setEditing(t); setEditText(t.text) }
  const saveEdit = async () => {
    const val = editText.trim()
    if (!val || savingEdit) return
    setSavingEdit(true)
    try {
      await editTopic(editing.id, val)
      setEditing(null)
    } catch (e) {
      flash(e.message || 'Could not update the topic')
    } finally {
      setSavingEdit(false)
    }
  }

  // Chosen from the suggestion modal: save the idea, mark the topic done, close.
  // Throws propagate to the modal so it can keep itself open on failure.
  const acceptIdea = async (topic, idea) => {
    await addIdea(ideaFromSuggestion(idea))
    await markDone(topic.id)
    setModalTopic(null)
    flash('Idea added to the bank — topic marked done')
  }

  return (
    <div className="card card-pad">
      {/* Composer first - it's the primary action. The page header already
          explains this tab, so the card doesn't repeat it. */}
      <div className="research-composer">
        <input
          className="field"
          value={text}
          placeholder="Add a research topic…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="btn btn-primary" onClick={add} disabled={!text.trim() || saving}>
          <Icon.Plus width={15} height={15} /> {saving ? 'Adding…' : 'Add topic'}
        </button>
      </div>

      {topics.length > 0 && (
        <div className="list-filters">
          <div className="search-box">
            <Icon.Search width={15} height={15} />
            <input
              className="field search-input"
              value={search}
              placeholder="Search topics…"
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && <button className="search-clear" aria-label="Clear search" onClick={() => setSearch('')}>×</button>}
          </div>
          <select className="field filter-select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort topics">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="az">A – Z</option>
            <option value="za">Z – A</option>
          </select>
          {ready && filtered.length > 0 && !bulk.selectMode && (
            <>
              <span className="bulk-spacer" />
              <button className="btn btn-ghost btn-sm" onClick={bulk.enter}><Icon.Check width={14} height={14} /> Select</button>
            </>
          )}
        </div>
      )}

      {ready && filtered.length > 0 && bulk.selectMode && (
        <BulkToolbar
          count={bulk.selected.size}
          allSelected={bulk.allSelected}
          onToggleAll={bulk.toggleAll}
          onDelete={() => setConfirmBulk(true)}
          onCancel={bulk.exit}
          deleting={bulkDeleting}
        />
      )}

      {!ready ? (
        <ResearchListSkeleton rows={5} />
      ) : (
        <motion.div key={page} className="research-list" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
          {pageRows.length > 0 && (
            <div className="research-head" aria-hidden="true">
              {bulk.selectMode && <span className="research-check-cell" />}
              <span className="rh-topic">Topic</span>
              <span className="rh-status">Status</span>
              <span className="rh-when">Added</span>
              {!bulk.selectMode && <span className="rh-actions">Actions</span>}
            </div>
          )}
          {pageRows.map((t) => (
            <div className={`research-item ${bulk.selected.has(t.id) ? 'selected' : ''}`} key={t.id}>
              {bulk.selectMode && (
                <input type="checkbox" className="research-check" aria-label="Select topic" checked={bulk.selected.has(t.id)} onChange={() => bulk.toggle(t.id)} />
              )}
              <p className="research-topic-text" title={bulk.selectMode ? 'Click to select' : 'Click to view / edit'} onClick={() => bulk.selectMode ? bulk.toggle(t.id) : openEdit(t)}>{t.text}</p>
              {/* Status and date always render a cell, even when empty - a
                  conditional pill would shift the columns out of alignment on
                  rows that aren't done yet. */}
              <span className="research-status">
                {t.status === 'done'
                  ? <span className="pill status status-published">Done</span>
                  : <span className="muted-text">—</span>}
              </span>
              <span className="research-when" title={t.createdAt ? `Added ${fmtWhen(t.createdAt)}` : undefined}>
                {t.createdAt ? fmtWhen(t.createdAt) : '—'}
              </span>
              {!bulk.selectMode && (
                <div className="research-actions">
                  <button className="btn btn-rose btn-sm" onClick={() => setModalTopic(t)}><Icon.Spark width={14} height={14} /> Get ideas</button>
                  <button className="icon-btn" title="Edit topic" aria-label="Edit topic" onClick={() => openEdit(t)}><Icon.Pen width={15} height={15} /></button>
                  <button className="icon-btn icon-btn-danger" title="Delete topic" aria-label="Delete topic" onClick={() => setConfirmTarget(t)}><Icon.Trash width={15} height={15} /></button>
                </div>
              )}
            </div>
          ))}
          {topics.length === 0 && <p className="muted-text" style={{ fontSize: 13 }}>No topics yet - add your first one above.</p>}
          {topics.length > 0 && filtered.length === 0 && <p className="muted-text" style={{ fontSize: 13 }}>No topics match your search.</p>}
        </motion.div>
      )}

      {ready && filtered.length > 0 && (
        <div className="pagination">
          <div className="page-size">
            <span>Rows per page</span>
            <select className="field filter-select" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} aria-label="Rows per page">
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="page-nav">
            <button className="icon-btn" disabled={page <= 1} aria-label="Previous page" onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <Icon.Chevron width={16} height={16} style={{ transform: 'rotate(180deg)' }} />
            </button>
            <span className="page-info">Page {page} of {totalPages}</span>
            <button className="icon-btn" disabled={page >= totalPages} aria-label="Next page" onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              <Icon.Chevron width={16} height={16} />
            </button>
          </div>
        </div>
      )}

      {modalTopic && (
        <SuggestModal
          topic={modalTopic}
          suggest={suggest}
          onChoose={(idea) => acceptIdea(modalTopic, idea)}
          onClose={() => setModalTopic(null)}
        />
      )}

      {editing && (
        <Modal title="Research topic" sub="View the full topic here, or edit it. Long text scrolls inside the box." onClose={() => !savingEdit && setEditing(null)}>
          <div className="stack">
            <div>
              <span className="label">Topic</span>
              <textarea
                className="field"
                autoFocus
                value={editText}
                placeholder="Research topic…"
                onChange={(e) => setEditText(e.target.value)}
                style={{ minHeight: 160 }}
              />
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setEditing(null)} disabled={savingEdit}>Cancel</button>
            <button className="btn btn-primary" onClick={saveEdit} disabled={!editText.trim() || savingEdit}>{savingEdit ? 'Saving…' : 'Save changes'}</button>
          </div>
        </Modal>
      )}

      {confirmTarget && (
        <Modal title="Delete this topic?" onClose={() => !deleting && setConfirmTarget(null)}>
          <div className="confirm-body">
            <span className="confirm-icon"><Icon.Trash width={20} height={20} /></span>
            <p className="confirm-text">
              <strong>“{confirmTarget.text}”</strong> will be permanently removed from your research topics. This can’t be undone.
            </p>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirmTarget(null)} disabled={deleting}>Cancel</button>
            <button className="btn btn-danger" onClick={confirmDelete} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete topic'}</button>
          </div>
        </Modal>
      )}

      {confirmBulk && (
        <Modal title={`Delete ${bulk.selected.size} topic${bulk.selected.size > 1 ? 's' : ''}?`} onClose={() => !bulkDeleting && setConfirmBulk(false)}>
          <div className="confirm-body">
            <span className="confirm-icon"><Icon.Trash width={20} height={20} /></span>
            <p className="confirm-text">
              <strong>{bulk.selected.size}</strong> selected topic{bulk.selected.size > 1 ? 's' : ''} will be permanently removed from your research topics. This can’t be undone.
            </p>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirmBulk(false)} disabled={bulkDeleting}>Cancel</button>
            <button className="btn btn-danger" onClick={bulkDelete} disabled={bulkDeleting}>{bulkDeleting ? 'Deleting…' : `Delete ${bulk.selected.size}`}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// Stream tab: live trending news topics
function StreamTab({ client, suggest, addIdea, markDone, flash }) {
  const [topics, setTopics] = useState([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [modalTopic, setModalTopic] = useState(null)
  
  const [confirmTarget, setConfirmTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)

  // --- bulk select / delete ---
  const bulk = useBulkSelect(topics.map((t) => t.id))
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)

  // --- pagination (matches the Manual tab) ---
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(STREAM_PAGE_SIZES[0])
  const totalPages = Math.max(1, Math.ceil(topics.length / pageSize))
  const pageRows = topics.slice((page - 1) * pageSize, page * pageSize)
  useEffect(() => { setPage((p) => Math.min(p, totalPages)) }, [totalPages])
  useEffect(() => { setPage(1) }, [pageSize])

  const bulkDelete = async () => {
    if (bulkDeleting) return
    setBulkDeleting(true)
    const ids = [...bulk.selected]
    try {
      await Promise.all(ids.map((id) => deleteResearchTopic(client.id, id)))
      setTopics((arr) => arr.filter((t) => !bulk.selected.has(t.id)))
      flash(`Deleted ${ids.length} topic${ids.length > 1 ? 's' : ''}`)
    } catch {
      flash('Could not delete some topics')
      await load() // resync with the server on partial failure
    } finally {
      setBulkDeleting(false)
      setConfirmBulk(false)
      bulk.exit()
    }
  }

  const load = useCallback(async () => {
    try {
      const rows = await listResearchTopics(client.id, 'stream')
      setTopics(rows)
    } catch {
      flash('Could not load stream topics')
    } finally {
      setLoading(false)
    }
  }, [client.id, flash])

  useEffect(() => { load() }, [load])

  const refreshStream = async () => {
    if (generating) return
    setGenerating(true)
    try {
      await generateStreamTopics(client.id)
      await load()
      flash('Stream refreshed!')
    } catch(e) {
      flash(e.message || 'Could not refresh stream')
    } finally {
      setGenerating(false)
    }
  }

  const confirmDelete = async () => {
    if (!confirmTarget || deleting) return
    setDeleting(true)
    try {
      await deleteResearchTopic(client.id, confirmTarget.id)
      setTopics((arr) => arr.filter((t) => t.id !== confirmTarget.id))
      setConfirmTarget(null)
    } catch {
      flash('Could not delete topic')
    } finally {
      setDeleting(false)
    }
  }
  
  const acceptIdea = async (topic, idea) => {
    await addIdea(ideaFromSuggestion(idea))
    await markDone(topic.id)
    setTopics((arr) => arr.map(t => t.id === topic.id ? { ...t, status: 'done' } : t))
    setModalTopic(null)
    flash('Idea added to the bank — topic marked done')
  }

  return (
    <div className="card card-pad">
      <div className="section-head">
        <div>
          <h2>Live industry news</h2>
          <p className="muted-text" style={{ fontSize: 13, marginTop: 2 }}>Refresh to pull the latest trends in your industry.</p>
        </div>
        <div className="page-head-actions">
          {!bulk.selectMode && topics.length > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={bulk.enter}><Icon.Check width={14} height={14} /> Select</button>
          )}
          <button className="btn btn-primary btn-sm" onClick={refreshStream} disabled={generating}>
            {generating ? 'Fetching…' : <><Icon.Spark width={14} height={14} /> Refresh stream</>}
          </button>
        </div>
      </div>

      {bulk.selectMode && topics.length > 0 && (
        <BulkToolbar
          count={bulk.selected.size}
          allSelected={bulk.allSelected}
          onToggleAll={bulk.toggleAll}
          onDelete={() => setConfirmBulk(true)}
          onCancel={bulk.exit}
          deleting={bulkDeleting}
        />
      )}

      <div style={{ marginTop: bulk.selectMode ? 0 : 24 }}>
        {loading ? (
          <ResearchListSkeleton />
        ) : topics.length === 0 ? (
          <div className="empty-state">
            <p className="muted-text">No trending topics yet — hit <strong>Refresh stream</strong> to pull the latest news.</p>
          </div>
        ) : (
          <motion.div key={page} className="research-list" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
            {pageRows.map((t) => {
              const parsed = parseTopic(t.text)
              return (
                <div key={t.id} className={`research-item ${bulk.selected.has(t.id) ? 'selected' : ''}`}>
                  {bulk.selectMode && (
                    <input type="checkbox" className="research-check" aria-label="Select topic" checked={bulk.selected.has(t.id)} onChange={() => bulk.toggle(t.id)} />
                  )}
                  <div className="stream-main" style={{ cursor: bulk.selectMode ? 'pointer' : 'default' }} onClick={bulk.selectMode ? () => bulk.toggle(t.id) : undefined}>
                    <p className="stream-headline">
                      {parsed.text}
                      {t.status === 'done' && <span className="pill status status-published" style={{ marginLeft: 10, verticalAlign: 'middle' }}>Done</span>}
                    </p>
                    {parsed.source && (
                      <a className="stream-source" href={parsed.source.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        Source: {parsed.source.label}
                      </a>
                    )}
                  </div>
                  {!bulk.selectMode && (
                    <div className="research-actions">
                      <button className="btn btn-rose btn-sm" onClick={() => setModalTopic(t)}><Icon.Spark width={14} height={14} /> Get ideas</button>
                      <button className="icon-btn icon-btn-danger" title="Delete topic" aria-label="Delete topic" onClick={() => setConfirmTarget(t)}><Icon.Trash width={15} height={15} /></button>
                    </div>
                  )}
                </div>
              )
            })}
          </motion.div>
        )}

        {!loading && topics.length > 0 && (
          <div className="pagination">
            <div className="page-size">
              <span>Rows per page</span>
              <select className="field filter-select" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} aria-label="Rows per page">
                {STREAM_PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div className="page-nav">
              <button className="icon-btn" disabled={page <= 1} aria-label="Previous page" onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <Icon.Chevron width={16} height={16} style={{ transform: 'rotate(180deg)' }} />
              </button>
              <span className="page-info">Page {page} of {totalPages}</span>
              <button className="icon-btn" disabled={page >= totalPages} aria-label="Next page" onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                <Icon.Chevron width={16} height={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {modalTopic && <SuggestModal topic={modalTopic} suggest={suggest} onChoose={(idea) => acceptIdea(modalTopic, idea)} onClose={() => setModalTopic(null)} />}
      
      {confirmTarget && (
        <Modal title="Delete stream topic?" onClose={() => !deleting && setConfirmTarget(null)}>
          <div style={{ padding: '0 0 20px 0' }}>
            <p style={{ margin: 0, lineHeight: 1.5 }}>
              <strong>“{confirmTarget.text}”</strong> will be permanently removed.
            </p>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirmTarget(null)} disabled={deleting}>Cancel</button>
            <button className="btn btn-danger" onClick={confirmDelete} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete topic'}</button>
          </div>
        </Modal>
      )}

      {confirmBulk && (
        <Modal title={`Delete ${bulk.selected.size} topic${bulk.selected.size > 1 ? 's' : ''}?`} onClose={() => !bulkDeleting && setConfirmBulk(false)}>
          <div style={{ padding: '0 0 20px 0' }}>
            <p style={{ margin: 0, lineHeight: 1.5 }}>
              <strong>{bulk.selected.size}</strong> selected topic{bulk.selected.size > 1 ? 's' : ''} will be permanently removed.
            </p>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirmBulk(false)} disabled={bulkDeleting}>Cancel</button>
            <button className="btn btn-danger" onClick={bulkDelete} disabled={bulkDeleting}>{bulkDeleting ? 'Deleting…' : `Delete ${bulk.selected.size}`}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

const TABS = [
  { key: 'manual', label: 'Manual' },
  { key: 'stream', label: 'Stream' },
]

export default function ResearchPage() {
  const { client, researchTopics, researchReady, addResearchTopic, removeResearchTopic, editResearchTopic, suggestResearchIdeas, markResearchTopicDone, addIdea, flash } = useOutletContext()
  const [tab, setTab] = useState('manual')

  return (
    <div className="view">
      <div className="page-head">
        <span className="eyebrow">Research</span>
        <h1>Gather the raw material</h1>
        <p className="lede">Capture topics by hand, or pull live industry news, then turn either into ideas.</p>
      </div>

      <div className="seg-tabs seg-tabs-anim">
        {TABS.map((t) => (
          <button key={t.key} className={`seg-tab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
            {tab === t.key && (
              <motion.span
                layoutId="research-tab-underline"
                className="seg-underline"
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              />
            )}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} variants={panelV} initial="hidden" animate="show" exit="exit">
          {tab === 'manual' ? (
            <ManualTab
              topics={researchTopics}
              ready={researchReady}
              addTopic={addResearchTopic}
              removeTopic={removeResearchTopic}
              editTopic={editResearchTopic}
              suggest={suggestResearchIdeas}
              addIdea={addIdea}
              markDone={markResearchTopicDone}
              flash={flash}
            />
          ) : (
            <StreamTab 
              client={client}
              suggest={suggestResearchIdeas}
              addIdea={addIdea}
              markDone={markResearchTopicDone}
              flash={flash}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
