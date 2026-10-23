import { useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Icon } from '../icons.jsx'
import { Modal } from '../components/Modal.jsx'
import { TableSkeleton } from '../components/Skeleton.jsx'
import { platformById, PLATFORMS } from '../data.js'
import { normalizeUrl } from '../lib/util.js'

const PRIORITIES = ['High', 'Medium', 'Low']
const EMPTY_IDEA = { audience: '', title: '', note: '', priority: '', tags: '', draftLink: '', platforms: [] }
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
const PAGE_SIZES = [10, 25, 50]
// Sortable columns and how each cell reduces to a comparable value. Blank
// priorities sort last; everything else falls back to a case-insensitive string.
const rank = (arr, v) => { const i = arr.indexOf(v); return i === -1 ? arr.length : i }
const SORTERS = {
  title: (i) => (i.title || '').toLowerCase(),
  channels: (i) => i.platforms?.length || 0,
  audience: (i) => (i.audience || '').toLowerCase(),
  priority: (i) => rank(PRIORITIES, i.priority),
}
const fmtDate = (iso) => {
  if (!iso) return '-'
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) }
  catch { return '-' }
}

export default function IdeaBankPage() {
  const { client, ideas, ideasReady, addIdea, updateIdea, removeIdea, startFromIdea, flash, wantNewIdea, clearNewIdea, photos = [], addPhoto } = useOutletContext()
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState(null) // null = adding, else editing this id
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(EMPTY_IDEA)

  // Content type (format) per selected channel + reference image(s) — chosen here
  // so "Create content" can generate straight away, skipping the generate modal's
  // first step. formatByPlat holds overrides; formatFor falls back to a default.
  const [formatByPlat, setFormatByPlat] = useState({})
  const [imagePhotos, setImagePhotos] = useState([]) // [{ id, url, title }]
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [visibleCount, setVisibleCount] = useState(8)
  const fileRef = useRef(null)
  const formatFor = (pid) => formatByPlat[pid] || platformById(pid)?.formats?.[0] || ''
  const [viewIdea, setViewIdea] = useState(null) // idea shown in the read-only detail modal
  const [confirmTarget, setConfirmTarget] = useState(null) // idea pending delete confirmation
  const [deleting, setDeleting] = useState(false)

  // --- Search / filter / sort / pagination state ---
  const [search, setSearch] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [channelFilter, setChannelFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [sort, setSort] = useState({ key: null, dir: 'asc' }) // null = keep source order
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])

  // Every distinct tag across all ideas, for the Tags filter dropdown. Tags are
  // normalized to uppercase so case-only variants (erp / ERP) collapse into one.
  const allTags = useMemo(
    () => [...new Set(ideas.flatMap((i) => (i.tags || []).map((t) => t.toUpperCase())))].sort((a, b) => a.localeCompare(b)),
    [ideas],
  )

  // Apply search + column filters, then the active column sort.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let rows = ideas.filter((i) => {
      if (priorityFilter && i.priority !== priorityFilter) return false
      if (channelFilter && !(i.platforms || []).includes(channelFilter)) return false
      if (tagFilter && !(i.tags || []).some((t) => t.toUpperCase() === tagFilter)) return false
      if (q) {
        const hay = [i.title, i.note, i.audience, ...(i.tags || [])].join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    if (sort.key) {
      const get = SORTERS[sort.key]
      const mult = sort.dir === 'asc' ? 1 : -1
      rows = [...rows].sort((a, b) => {
        const av = get(a), bv = get(b)
        if (av < bv) return -1 * mult
        if (av > bv) return 1 * mult
        return 0
      })
    }
    return rows
  }, [ideas, search, priorityFilter, channelFilter, tagFilter, sort])

  const hasFilters = search || priorityFilter || channelFilter || tagFilter
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize)

  // Snap the page back into range whenever the filtered set or page size shrinks.
  useEffect(() => { setPage((p) => Math.min(p, totalPages)) }, [totalPages])
  // Any filter/search/sort change returns to the first page.
  useEffect(() => { setPage(1) }, [search, priorityFilter, channelFilter, tagFilter, sort, pageSize])

  // Click a header: same column toggles direction, a new column starts ascending.
  const toggleSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  const resetFilters = () => {
    setSearch(''); setPriorityFilter(''); setChannelFilter(''); setTagFilter(''); setSort({ key: null, dir: 'asc' })
  }
  const sortIndicator = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '')

  // Platform choices come from the client's own profile (the social accounts set
  // during onboarding), in canonical order. Fall back to all platforms if the
  // client hasn't configured any yet.
  const accounts = client.social_media_accounts || []
  const available = PLATFORMS.filter((p) => accounts.some((s) => s.platform === p.id))
  const platformChoices = available.length ? available : PLATFORMS
  // default selection: LinkedIn if the client has it, else the first available
  const defaultPlatforms = () => {
    const ids = platformChoices.map((p) => p.id)
    return [ids.includes('linkedin') ? 'linkedin' : ids[0]].filter(Boolean)
  }

  // Clear the per-open content-type + image selections.
  const resetCreateExtras = () => { setFormatByPlat({}); setImagePhotos([]); setVisibleCount(8); setDragOver(false) }

  // Open the modal in "add" mode: a fresh form with a sensible default channel.
  const openAdd = () => {
    setEditingId(null)
    setForm({ ...EMPTY_IDEA, platforms: defaultPlatforms() })
    resetCreateExtras()
    setOpen(true)
  }
  // Open the modal in "edit" mode: prefill the form from an existing idea.
  const openEdit = (idea) => {
    setEditingId(idea.id)
    setForm({
      title: idea.title || '',
      note: idea.note || '',
      audience: idea.audience || '',
      priority: idea.priority || '',
      tags: (idea.tags || []).join(', '),
      draftLink: idea.draftLink || '',
      platforms: idea.platforms?.length ? idea.platforms : defaultPlatforms(),
    })
    // Prefill any content type + reference images saved on this idea.
    setFormatByPlat(idea.contentType && typeof idea.contentType === 'object' ? idea.contentType : {})
    setImagePhotos(Array.isArray(idea.refImages) ? idea.refImages : [])
    setVisibleCount(8)
    setDragOver(false)
    setOpen(true)
  }
  const togglePlatform = (id) =>
    setForm((f) => ({
      ...f,
      platforms: f.platforms.includes(id) ? f.platforms.filter((x) => x !== id) : [...f.platforms, id],
    }))

  // Open the add-idea modal when the "New idea" action set the intent,
  // then clear it so returning to this page later doesn't reopen the modal.
  useEffect(() => {
    if (wantNewIdea) {
      openAdd()
      clearNewIdea()
    }
  }, [wantNewIdea, clearNewIdea])

  // Persist the idea (create or update), then reset + close the form.
  const save = async () => {
    if (!form.title.trim() || saving) return
    setSaving(true)
    try {
      if (editingId) {
        await updateIdea(editingId, ideaPayload())
        flash('Idea updated')
      } else {
        await addIdea(ideaPayload())
        flash('Idea saved to the bank')
      }
      setForm(EMPTY_IDEA)
      setEditingId(null)
      resetCreateExtras()
      setOpen(false)
    } catch (e) {
      flash(e.message || 'Could not save the idea')
    } finally {
      setSaving(false)
    }
  }

  // Build the payload shared by "Save idea" and "Create content". The content
  // type + reference images are persisted on the idea so the row "Create" button
  // can generate straight away without re-asking.
  const ideaPayload = () => {
    const platforms = form.platforms.length ? form.platforms : ['linkedin']
    return {
      title: form.title.trim(),
      note: form.note.trim(),
      audience: form.audience.trim(),
      priority: form.priority,
      draftLink: form.draftLink.trim(),
      tags: [...new Set(form.tags.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean))],
      platforms,
      contentType: Object.fromEntries(platforms.map((pid) => [pid, formatFor(pid)])),
      refImages: imagePhotos.map((p) => ({ id: p.id, url: p.url, title: p.title || '' })),
    }
  }

  // Save (or update) the idea, then launch generation immediately with the chosen
  // content types + reference image — the generate modal auto-starts and lands on
  // the review stage, image-grounded when an image was added.
  const createContent = async () => {
    if (!form.title.trim() || saving || uploading) return
    setSaving(true)
    const payload = ideaPayload()
    try {
      const savedIdea = editingId ? await updateIdea(editingId, payload) : await addIdea(payload)
      startFromIdea(savedIdea, { formatByPlat: payload.contentType, imagePhotos: payload.refImages, autoStart: true })
      setForm(EMPTY_IDEA)
      setEditingId(null)
      resetCreateExtras()
      setOpen(false)
    } catch (e) {
      flash(e.message || 'Could not create content')
    } finally {
      setSaving(false)
    }
  }

  // --- Reference image: upload into the Photo Library, or pick existing ones ---
  const uploadImages = async (files) => {
    const list = Array.isArray(files) ? files : Array.from(files || [])
    if (!list.length) return
    setUploading(true)
    try {
      const saved = []
      for (const file of list) {
        const row = await addPhoto(file, file.name)
        if (row?.id) saved.push(row)
      }
      if (saved.length) setImagePhotos((prev) => [...prev, ...saved.filter((s) => !prev.some((p) => p.id === s.id))])
    } catch (e) {
      flash(e.message || 'Could not upload the image')
    } finally {
      setUploading(false)
    }
  }
  const onPickImage = (e) => { const files = e.target.files; if (files?.length) uploadImages(files); e.target.value = '' }
  const onDropImage = (e) => { e.preventDefault(); setDragOver(false); uploadImages(e.dataTransfer?.files) }
  const toggleLibraryPhoto = (ph) =>
    setImagePhotos((prev) => prev.some((p) => p.id === ph.id)
      ? prev.filter((p) => p.id !== ph.id)
      : [...prev, { id: ph.id, url: ph.url, title: ph.title }])
  const removeImage = (id) => setImagePhotos((prev) => prev.filter((p) => p.id !== id))

  // Delete is confirmed through a modal first (removeIdea is optimistic + rolls
  // back on failure, so awaiting here just lets the button show progress).
  const confirmDelete = async () => {
    if (!confirmTarget || deleting) return
    setDeleting(true)
    await removeIdea(confirmTarget.id)
    setDeleting(false)
    setConfirmTarget(null)
  }

  return (
    <div className="view">
      <div className="page-head idea-head">
        <div>
          <span className="eyebrow">Idea Bank</span>
          <h1>Turn research into ideas</h1>
        </div>
        <button className="btn btn-rose btn-sm" onClick={openAdd}><Icon.Plus /> Add idea</button>
      </div>

      {ideas.length > 0 && (
        <div className="list-filters">
          <div className="search-box">
            <Icon.Search width={15} height={15} />
            <input
              className="field search-input"
              value={search}
              placeholder="Search ideas, notes, audience, tags…"
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && <button className="search-clear" aria-label="Clear search" onClick={() => setSearch('')}>×</button>}
          </div>
          <select className="field filter-select" value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} aria-label="Filter by priority">
            <option value="">All priorities</option>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select className="field filter-select" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} aria-label="Filter by channel">
            <option value="">All channels</option>
            {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className="field filter-select" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} disabled={!allTags.length} aria-label="Filter by tag">
            <option value="">All tags</option>
            {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {hasFilters && (
            <div className="filter-actions">
              <button className="btn btn-ghost btn-sm" onClick={resetFilters}>Clear</button>
            </div>
          )}
        </div>
      )}

      {!ideasReady ? (
        <TableSkeleton rows={6} cols={6} />
      ) : ideas.length === 0 ? (
        <div className="card idea-empty">
          <span className="plus">+</span>
          <p>No ideas yet - capture a topic, story or angle to start the bank.</p>
          <button className="btn btn-rose btn-sm" onClick={openAdd}>Add an idea</button>
        </div>
      ) : (
        <>
        <div className="card idea-table-wrap">
          <table className="idea-table">
            <thead>
              <tr>
                <th><button className="th-sort" onClick={() => toggleSort('title')}>Idea{sortIndicator('title')}</button></th>
                <th><button className="th-sort" onClick={() => toggleSort('channels')}>Channels{sortIndicator('channels')}</button></th>
                <th><button className="th-sort" onClick={() => toggleSort('audience')}>Audience{sortIndicator('audience')}</button></th>
                <th>Tags</th>
                <th><button className="th-sort" onClick={() => toggleSort('priority')}>Priority{sortIndicator('priority')}</button></th>
                <th className="ta-actions-head">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 && (
                <tr><td colSpan={6} className="ta-empty">No ideas match your filters.</td></tr>
              )}
              {pageRows.map((idea) => (
                <tr key={idea.id} className="idea-row-click" onClick={() => setViewIdea(idea)}>
                  <td className="ta-title">
                    <span className="ta-name" title={idea.title}>{idea.title}</span>
                    {idea.note && <span className="ta-note">{idea.note}</span>}
                  </td>
                  <td>
                    <span className="ta-channels">
                      <span className="muted-text">{idea.platforms?.length || 0}</span>
                    </span>
                  </td>
                  <td>{idea.audience || <span className="muted-text">-</span>}</td>
                  <td>
                    {idea.tags.length > 0
                      ? <div className="ta-tags">
                          {idea.tags.slice(0, 2).map((t) => <span className="pill" key={t}>{t}</span>)}
                          {idea.tags.length > 2 && <span className="pill pill-more" title={idea.tags.slice(2).join(', ')}>+{idea.tags.length - 2}</span>}
                        </div>
                      : <span className="muted-text">-</span>}
                  </td>
                  <td>{idea.priority ? <span className={`pill prio prio-${slug(idea.priority)}`}>{idea.priority}</span> : <span className="muted-text">-</span>}</td>
                  <td className="ta-actions" onClick={(e) => e.stopPropagation()}>
                    <div className="ta-actions-inner">
                      <button className="btn btn-rose btn-sm" onClick={() => startFromIdea(idea)}>Create <Icon.Arrow className="arrow" /></button>
                      <button className="icon-btn" title="Edit idea" aria-label="Edit idea" onClick={() => openEdit(idea)}><Icon.Pen width={15} height={15} /></button>
                      <button className="icon-btn icon-btn-danger" title="Delete idea" aria-label="Delete idea" onClick={() => setConfirmTarget(idea)}><Icon.Trash width={15} height={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
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
        </>
      )}

      {open && (
        <Modal
          title={editingId ? 'Edit idea' : 'Add an idea'}
          sub={editingId ? 'Update the topic, channels or details for this idea.' : "Drop a topic now - shape it into content whenever you're ready."}
          onClose={() => setOpen(false)}
        >
          <div className="stack">
            <div><span className="label">Topic / headline</span><input className="field" autoFocus value={form.title} placeholder="e.g. What a content system actually looks like" onChange={(e) => setForm({ ...form, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && save()} /></div>
            <div><span className="label">Description <span className="muted-text">(note / angle)</span></span><textarea className="field" value={form.note} placeholder="The story, stat or point of view behind it…" onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
            <div><span className="label">Audience</span><input className="field" value={form.audience} placeholder="e.g. PE operators" onChange={(e) => setForm({ ...form, audience: e.target.value })} /></div>
            <div><span className="label">Priority</span>
              <select className="field" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                <option value="">None</option>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <span className="label">Platforms <span className="muted-text">(channels this idea targets)</span></span>
              <div className="chip-row" style={{ marginTop: 6 }}>
                {platformChoices.map((p) => {
                  const on = form.platforms.includes(p.id)
                  return (
                    <button type="button" key={p.id} className={`chip ${on ? 'on' : ''}`} onClick={() => togglePlatform(p.id)}>
                      <span className={`chk-mini ${on ? 'on' : ''}`}>{on && <Icon.Check width={10} height={10} />}</span>
                      <span className={`dot ${p.dot}`} /> {p.name}
                    </button>
                  )
                })}
              </div>
            </div>
            {form.platforms.length > 0 && (
              <div>
                <span className="label">Content type <span className="muted-text">(per channel)</span></span>
                <div className="fmt-rows" style={{ marginTop: 6 }}>
                  {form.platforms.map((pid) => {
                    const pp = platformById(pid)
                    if (!pp) return null
                    return (
                      <div className="fmt-row" key={pid}>
                        <span className="fmt-row-plat"><span className={`dot ${pp.dot}`} /> {pp.name}</span>
                        <div className="chip-row">
                          {pp.formats.map((f) => (
                            <button type="button" key={f} className={`chip ${formatFor(pid) === f ? 'on' : ''}`} onClick={() => setFormatByPlat((m) => ({ ...m, [pid]: f }))}>{f}</button>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            <div><span className="label">Tags <span className="muted-text">(comma separated)</span></span><input className="field" value={form.tags} placeholder="Thought leadership, Systems" onChange={(e) => setForm({ ...form, tags: e.target.value })} /></div>
            <div><span className="label">Draft link <span className="muted-text">(optional)</span></span><input className="field" type="url" value={form.draftLink} placeholder="https://…" onChange={(e) => setForm({ ...form, draftLink: e.target.value })} onBlur={(e) => setForm((f) => ({ ...f, draftLink: normalizeUrl(e.target.value) }))} /></div>

            {/* Reference image — optional; when added, "Create content" generates
                drafts grounded in what it shows. Uploads land in the Photo Library. */}
            <div>
              <span className="label">Reference image <span className="muted-text">(optional · grounds the drafts in what it shows)</span></span>
              <input ref={fileRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={onPickImage} />
              {imagePhotos.length > 0 ? (
                <div className="gen-selected" style={{ marginTop: 6 }}>
                  {imagePhotos.map((ph) => (
                    <div key={ph.id} className="gen-selected-item">
                      <img src={ph.url} alt={ph.title || 'Selected image'} />
                      <button className="photo-remove" aria-label="Remove image" onClick={() => removeImage(ph.id)}>✕</button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className={`gen-add-more ${uploading ? 'busy' : ''} ${dragOver ? 'drag' : ''}`}
                    onClick={() => fileRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={onDropImage}
                  >
                    <Icon.Plus width={20} height={20} />
                    <span>Add more</span>
                  </button>
                </div>
              ) : (
                <div
                  className={`gen-drop ${uploading ? 'busy' : ''} ${dragOver ? 'drag' : ''}`}
                  style={{ marginTop: 6 }}
                  role="button"
                  tabIndex={0}
                  onClick={() => fileRef.current?.click()}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDropImage}
                >
                  <Icon.Image width={26} height={26} />
                  <span className="gen-drop-title">{uploading ? 'Uploading…' : 'Browse or drop images'}</span>
                  <span className="gen-drop-sub">JPG, PNG, WEBP or GIF · stored in your Photo Library</span>
                </div>
              )}
              {photos.length > 0 && (
                <div className="gen-lib">
                  <span className="mini-label">Or pick from your Photo Library</span>
                  <div className="gen-lib-grid">
                    {photos.slice(0, visibleCount).map((ph) => (
                      <button
                        type="button"
                        key={ph.id}
                        className={`gen-lib-item ${imagePhotos.some((p) => p.id === ph.id) ? 'sel' : ''}`}
                        title={ph.title}
                        onClick={() => toggleLibraryPhoto(ph)}
                      >
                        <img src={ph.url} alt={ph.title || 'Photo'} loading="lazy" />
                      </button>
                    ))}
                  </div>
                  {visibleCount < photos.length && (
                    <button type="button" className="btn btn-ghost btn-sm gen-lib-more" onClick={() => setVisibleCount((n) => Math.min(n + 8, photos.length))}>
                      Load more ({photos.length - visibleCount} more)
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={!form.title.trim() || saving || uploading}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Save idea'}</button>
            <button className="btn btn-rose" onClick={createContent} disabled={!form.title.trim() || saving || uploading}>
              <Icon.Spark width={15} height={15} /> Create content
            </button>
          </div>
        </Modal>
      )}

      {viewIdea && (
        <Modal title={viewIdea.title} onClose={() => setViewIdea(null)}>
          <div className="idea-detail">
            <div className="idea-detail-pills">
              {viewIdea.priority && <span className={`pill prio prio-${slug(viewIdea.priority)}`}>{viewIdea.priority}</span>}
            </div>

            {viewIdea.note && (
              <p className="idea-detail-note" style={{ whiteSpace: 'pre-wrap' }}>
                {viewIdea.note.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
                  /(https?:\/\/[^\s]+)/.test(part) ? (
                    <a key={i} href={part} target="_blank" rel="noreferrer" className="link-btn" style={{ wordBreak: 'break-all' }}>{part}</a>
                  ) : (
                    part
                  )
                )}
              </p>
            )}

            <dl className="idea-detail-grid">
              <div>
                <dt>Channels</dt>
                <dd>
                  {viewIdea.platforms?.length
                    ? <span className="idea-detail-channels">{viewIdea.platforms.map((pid) => (
                        <span className="idea-detail-channel" key={pid}><span className={`dot ${platformById(pid)?.dot}`} /> {platformById(pid)?.name || pid}</span>
                      ))}</span>
                    : <span className="muted-text">-</span>}
                </dd>
              </div>
              <div><dt>Audience</dt><dd>{viewIdea.audience || <span className="muted-text">-</span>}</dd></div>
              <div>
                <dt>Tags</dt>
                <dd>{viewIdea.tags?.length
                  ? <div className="ta-tags">{viewIdea.tags.map((t) => <span className="pill" key={t}>{t}</span>)}</div>
                  : <span className="muted-text">-</span>}</dd>
              </div>
              <div>
                <dt>Draft link</dt>
                <dd>{viewIdea.draftLink
                  ? <a className="link-btn" href={viewIdea.draftLink} target="_blank" rel="noreferrer">Open draft ↗</a>
                  : <span className="muted-text">-</span>}</dd>
              </div>
              <div><dt>Added</dt><dd>{fmtDate(viewIdea.createdAt)}</dd></div>
            </dl>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => { const i = viewIdea; setViewIdea(null); openEdit(i) }}>Edit</button>
            <button className="btn btn-primary" onClick={() => startFromIdea(viewIdea)}>Create content <Icon.Arrow className="arrow" /></button>
          </div>
        </Modal>
      )}

      {confirmTarget && (
        <Modal title="Delete this idea?" onClose={() => !deleting && setConfirmTarget(null)}>
          <div className="confirm-body">
            <span className="confirm-icon"><Icon.Trash width={20} height={20} /></span>
            <p className="confirm-text">
              <strong>“{confirmTarget.title}”</strong> will be permanently removed from the idea bank. This can’t be undone.
            </p>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirmTarget(null)} disabled={deleting}>Cancel</button>
            <button className="btn btn-danger" onClick={confirmDelete} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete idea'}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
