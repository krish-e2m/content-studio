import { useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Icon } from '../icons.jsx'
import { Modal } from '../components/Modal.jsx'
import { PostPreview } from '../components/PostPreview.jsx'
import { DatePicker } from '../components/DatePicker.jsx'
import { TableSkeleton } from '../components/Skeleton.jsx'
import { PLATFORMS, platformById } from '../data.js'
import { PostStatsModal } from '../components/PostStatsModal.jsx'
import { PLATFORM_POSTS } from '../performanceData.js'

const STATUSES = ['draft', 'scheduled', 'published']
const PAGE_SIZES = [10, 25, 50]
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')
const fmtDate = (iso) => {
  if (!iso) return '-'
  try { return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) }
  catch { return iso }
}

// The Posts tab: every row in the posts table (one per platform), with search +
// platform/status filters. Click a row to preview it, or edit/delete inline.
export default function PostsPage() {
  const { client, posts, postsReady, photos, addPhoto, removePost, updatePost, flash } = useOutletContext()
  const [search, setSearch] = useState('')
  const [platformFilter, setPlatformFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const [viewPost, setViewPost] = useState(null)
  const [confirmTarget, setConfirmTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [editPost, setEditPost] = useState(null) // the post being edited
  const [editForm, setEditForm] = useState(null)
  const [editView, setEditView] = useState('edit') // 'edit' | 'preview'
  const [savingEdit, setSavingEdit] = useState(false)
  const [editErr, setEditErr] = useState('')
  const [viewStats, setViewStats] = useState(null)

  const [pickerMode, setPickerMode] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [previewImage, setPreviewImage] = useState(null)
  const fileRef = useRef(null)

  const uploadFile = async (files) => {
    const fileList = Array.isArray(files) ? files : Array.from(files || [])
    if (!fileList.length) return
    setUploading(true)
    try {
      const savedPhotos = []
      for (const file of fileList) {
        const saved = await addPhoto(file, file.name)
        if (saved?.id) savedPhotos.push(saved)
      }
      if (savedPhotos.length > 0) {
        setEditForm(prev => {
          const newPaths = savedPhotos.map(p => p.url).filter(url => !(prev.imagePaths || []).includes(url))
          return { ...prev, imagePaths: [...(prev.imagePaths || []), ...newPaths] }
        })
      }
    } catch (err) {
      flash(err.message || 'Could not upload the images')
    } finally {
      setUploading(false)
    }
  }
  const onPickImage = (e) => { const files = e.target.files; if (!files?.length) return; uploadFile(files); e.target.value = ''; }
  const onDropImage = (e) => { e.preventDefault(); setDragOver(false); uploadFile(e.dataTransfer?.files) }
  
  const toggleLibraryPhoto = (ph) => {
    setEditForm(prev => {
      const paths = prev.imagePaths || []
      const newPaths = paths.includes(ph.url) ? paths.filter(url => url !== ph.url) : [...paths, ph.url]
      return { ...prev, imagePaths: newPaths }
    })
  }
  const removeImage = (url) => setEditForm(prev => ({ ...prev, imagePaths: (prev.imagePaths || []).filter(u => u !== url) }))

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (posts || []).filter((p) => {
      if (platformFilter && p.platform !== platformFilter) return false
      if (statusFilter && p.status !== statusFilter) return false
      if (q) {
        const hay = [p.title, p.content, p.note, ...(p.tags || [])].join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [posts, search, platformFilter, statusFilter])

  const hasFilters = search || platformFilter || statusFilter
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize)

  useEffect(() => { setPage((p) => Math.min(p, totalPages)) }, [totalPages])
  useEffect(() => { setPage(1) }, [search, platformFilter, statusFilter, pageSize])

  const resetFilters = () => { setSearch(''); setPlatformFilter(''); setStatusFilter('') }

  const confirmDelete = async () => {
    if (!confirmTarget || deleting) return
    setDeleting(true)
    await removePost(confirmTarget.id)
    setDeleting(false)
    setConfirmTarget(null)
    if (viewPost?.id === confirmTarget.id) setViewPost(null)
    if (editPost?.id === confirmTarget.id) setEditPost(null)
  }

  const openEdit = (p) => {
    setViewPost(null)
    setEditErr('')
    setEditView('edit')
    setEditForm({
      title: p.title || '',
      content: p.content || '',
      format: p.format || '',
      status: p.status || 'scheduled',
      scheduledAt: p.scheduledAt || '',
      tags: (p.tags || []).join(', '),
      imagePaths: p.imagePaths || [],
    })
    setPickerMode(null)
    setPreviewImage(null)
    setEditPost(p)
  }

  const saveEdit = async () => {
    if (!editPost || savingEdit) return
    
    if (editPost.platform === 'instagram' && (!editForm.imagePaths || editForm.imagePaths.length === 0)) {
      setEditErr('At least one image is required as Instagram is a media first platform.')
      return
    }

    setSavingEdit(true)
    setEditErr('')
    try {
      await updatePost(editPost.id, {
        title: editForm.title.trim() || 'Untitled',
        content: editForm.content,
        format: editForm.format,
        status: editForm.status,
        scheduledAt: editForm.scheduledAt || null,
        tags: [...new Set(editForm.tags.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean))],
        imagePaths: editForm.imagePaths,
      })
      flash('Post updated')
      setEditPost(null)
    } catch (e) {
      setEditErr(e.message || 'Could not update the post')
    } finally {
      setSavingEdit(false)
    }
  }

  return (
    <div className="view">
      <div className="page-head">
        <span className="eyebrow">Posts</span>
        <h1>Everything you've created</h1>
      </div>

      {(posts?.length > 0) && (
        <div className="list-filters">
          <div className="search-box">
            <Icon.Search width={15} height={15} />
            <input className="field search-input" value={search} placeholder="Search posts, notes, tags…" onChange={(e) => setSearch(e.target.value)} />
            {search && <button className="search-clear" aria-label="Clear search" onClick={() => setSearch('')}>×</button>}
          </div>
          <select className="field filter-select" value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)} aria-label="Filter by platform">
            <option value="">All channels</option>
            {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className="field filter-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{cap(s)}</option>)}
          </select>
          {hasFilters && (
            <div className="filter-actions">
              <button className="btn btn-ghost btn-sm" onClick={resetFilters}>Clear</button>
            </div>
          )}
        </div>
      )}

      {!postsReady ? (
        <TableSkeleton rows={6} cols={6} />
      ) : posts.length === 0 ? (
        <div className="card idea-empty">
          <span className="plus">+</span>
          <p>No posts yet — open an idea in the Idea Bank and hit <strong>Create</strong> to generate and schedule one.</p>
        </div>
      ) : (
        <>
          <div className="card idea-table-wrap">
            <table className="idea-table">
              <thead>
                <tr>
                  <th>Post</th>
                  <th>Channel</th>
                  <th>Format</th>
                  <th>Status</th>
                  <th>Publish date</th>
                  <th className="ta-actions-head">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 && <tr><td colSpan={6} className="ta-empty">No posts match your filters.</td></tr>}
                {pageRows.map((p) => {
                  const plat = platformById(p.platform)
                  const snippet = (p.content || '').replace(/\s+/g, ' ').trim()
                  return (
                    <tr key={p.id} className="idea-row-click" onClick={() => setViewPost(p)}>
                      <td className="ta-title">
                        <span className="ta-name" title={p.title}>{p.title || 'Untitled'}</span>
                        {snippet && <span className="ta-note">{snippet.slice(0, 90)}{snippet.length > 90 ? '…' : ''}</span>}
                      </td>
                      <td><span className="row" style={{ gap: 6 }}>{plat ? <><span className={`dot ${plat.dot}`} />{plat.name}</> : <span className="muted-text">{p.platform || '-'}</span>}</span></td>
                      <td>{p.format || <span className="muted-text">-</span>}</td>
                      <td><span className={`pill status status-${slug(p.status)}`}>{cap(p.status)}</span></td>
                      <td>{p.scheduledAt ? fmtDate(p.scheduledAt) : <span className="muted-text">-</span>}</td>
                      <td className="ta-actions" onClick={(e) => e.stopPropagation()}>
                        <div className="ta-actions-inner">
                          <button className="icon-btn" title="View post" aria-label="View post" onClick={() => setViewPost(p)}><Icon.Eye width={15} height={15} /></button>
                          <button className="icon-btn" title="Edit post" aria-label="Edit post" onClick={() => openEdit(p)}><Icon.Pen width={15} height={15} /></button>
                          {p.status === 'published' && (() => {
                            const perfPost = (PLATFORM_POSTS[p.platform] || []).find((pp) =>
                              pp.title?.toLowerCase().includes((p.title || '').toLowerCase().slice(0, 12)) ||
                              (p.title || '').toLowerCase().includes((pp.title || '').toLowerCase().slice(0, 12))
                            ) || (PLATFORM_POSTS[p.platform] || [])[0]
                            return perfPost ? (
                              <button
                                className="icon-btn"
                                title="View stats"
                                aria-label="View stats"
                                onClick={() => setViewStats(perfPost)}
                              >
                                <Icon.BarChart width={15} height={15} />
                              </button>
                            ) : null
                          })()}
                          <button className="icon-btn icon-btn-danger" title="Delete post" aria-label="Delete post" onClick={() => setConfirmTarget(p)}><Icon.Trash width={15} height={15} /></button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
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
                <button className="icon-btn" disabled={page <= 1} aria-label="Previous page" onClick={() => setPage((p) => Math.max(1, p - 1))}><Icon.Chevron width={16} height={16} style={{ transform: 'rotate(180deg)' }} /></button>
                <span className="page-info">Page {page} of {totalPages}</span>
                <button className="icon-btn" disabled={page >= totalPages} aria-label="Next page" onClick={() => setPage((p) => Math.min(totalPages, p + 1))}><Icon.Chevron width={16} height={16} /></button>
              </div>
            </div>
          )}
        </>
      )}

      {viewPost && (() => {
        const plat = platformById(viewPost.platform)
        const mappedPhotoIds = (viewPost.imagePaths || []).map(url => photos.find(ph => ph.url === url)?.id).filter(Boolean)
        const visual = viewPost.imagePaths?.length
          ? { path: 'photo', photoIds: mappedPhotoIds, src: viewPost.imagePaths[0], prompt: viewPost.imagePrompt || '' }
          : { path: null, photoIds: [], src: '', prompt: '' }
        return (
          <Modal wide title={viewPost.title || 'Untitled'} sub={`${plat?.name || viewPost.platform} · ${viewPost.format || '—'} · ${cap(viewPost.status)}${viewPost.scheduledAt ? ` · ${fmtDate(viewPost.scheduledAt)}` : ''}`} onClose={() => setViewPost(null)}>
            <PostPreview client={client} platform={viewPost.platform} format={viewPost.format} draft={{ body: viewPost.content, hashtags: (viewPost.tags || []).map((t) => '#' + String(t).replace(/[^a-zA-Z0-9]+/g, '')).filter((h) => h.length > 1).join(' ') }} visual={visual} photos={photos} topic={viewPost.title} />
            <div className="modal-actions modal-actions-sticky modal-actions-split">
              <button className="btn btn-danger" onClick={() => setConfirmTarget(viewPost)}>Delete</button>
              <span className="row" style={{ gap: 10 }}>
                <button className="btn btn-ghost" onClick={() => setViewPost(null)}>Close</button>
                <button className="btn btn-primary" onClick={() => openEdit(viewPost)}><Icon.Pen width={14} height={14} /> Edit</button>
              </span>
            </div>
          </Modal>
        )
      })()}

      {editPost && editForm && (() => {
        const plat = platformById(editPost.platform)
        const formats = plat?.formats || []
        const formatOpts = editForm.format && !formats.includes(editForm.format) ? [editForm.format, ...formats] : formats
        const mappedPhotoIds = (editForm.imagePaths || []).map(url => photos.find(ph => ph.url === url)?.id).filter(Boolean)
        const visual = editForm.imagePaths?.length
          ? { path: 'photo', photoIds: mappedPhotoIds, src: editForm.imagePaths[0], prompt: editPost.imagePrompt || '' }
          : { path: null, photoIds: [], src: '', prompt: '' }
        const draft = { body: editForm.content, hashtags: editForm.tags.split(',').map((t) => '#' + t.trim().replace(/[^a-zA-Z0-9]+/g, '')).filter((h) => h.length > 1).join(' ') }
        return (
          <Modal wide title="Edit post" sub={`${plat?.name || editPost.platform} · ${editForm.format || '—'}`} onClose={() => !savingEdit && setEditPost(null)} className="gen-modal">
            {editErr && <div className="gen-error">{editErr}</div>}
            <div className="seg-tabs gen-view-tabs" style={{ marginBottom: 14 }}>
              <button className={`seg-tab ${editView === 'edit' ? 'on' : ''}`} onClick={() => setEditView('edit')}><Icon.Pen width={13} height={13} /> Edit</button>
              <button className={`seg-tab ${editView === 'preview' ? 'on' : ''}`} onClick={() => setEditView('preview')}><Icon.Eye width={14} height={14} /> Preview</button>
            </div>

            {editView === 'edit' ? (
              <div className="stack">
                <div><span className="label">Title</span><input className="field" value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} /></div>
                <div><span className="label">Content</span><textarea className="field" style={{ minHeight: 200, lineHeight: 1.6, fontSize: 14.5 }} value={editForm.content} onChange={(e) => setEditForm({ ...editForm, content: e.target.value })} /></div>
                <div className="gen-edit-grid">
                  <div>
                    <span className="label">Content type</span>
                    <select className="field" value={editForm.format} onChange={(e) => setEditForm({ ...editForm, format: e.target.value })}>
                      {!formatOpts.length && <option value="">—</option>}
                      {formatOpts.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                  <div>
                    <span className="label">Status</span>
                    <select className="field" value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}>
                      {STATUSES.map((s) => <option key={s} value={s}>{cap(s)}</option>)}
                    </select>
                  </div>
                  <div>
                    <span className="label">Publish date</span>
                    <DatePicker value={editForm.scheduledAt || ''} onChange={(v) => setEditForm({ ...editForm, scheduledAt: v })} disablePast />
                  </div>
                </div>
                <div><span className="label">Tags <span className="muted-text">(comma separated)</span></span><input className="field" value={editForm.tags} onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })} /></div>

                {pickerMode === 'picker' ? (
                  <div className="gen-formats" style={{ marginTop: 20 }}>
                    <input ref={fileRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={onPickImage} />
                    <div
                      className={`gen-drop ${uploading ? 'busy' : ''} ${dragOver ? 'drag' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => fileRef.current?.click()}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileRef.current?.click()}
                      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={onDropImage}
                      style={{ marginBottom: 20 }}
                    >
                      <Icon.Image width={26} height={26} />
                      <span className="gen-drop-title">{uploading ? 'Uploading…' : 'Browse or drop images'}</span>
                      <span className="gen-drop-sub">JPG, PNG, WEBP or GIF · stored in your Photo Library</span>
                    </div>

                    <span className="mini-label" style={{ marginBottom: 12 }}>OR PICK FROM YOUR PHOTO LIBRARY</span>
                    <div className="gen-lib-grid" style={{ maxHeight: 240, overflowY: 'auto', padding: 4 }}>
                        {(!photos || photos.length === 0) ? (
                          <p className="muted-text">No photos in library.</p>
                        ) : photos.map(ph => (
                          <button
                            type="button"
                            key={ph.id}
                            className={`gen-lib-item ${(editForm.imagePaths || []).includes(ph.url) ? 'sel' : ''}`}
                            title={ph.title}
                            onClick={() => toggleLibraryPhoto(ph)}
                          >
                            <img src={ph.url} alt={ph.title || 'Photo'} loading="lazy" />
                          </button>
                        ))}
                    </div>
                    
                    <div className="modal-actions" style={{ borderTop: 'none', padding: 0, marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
                        <button className="btn btn-primary" onClick={() => setPickerMode(null)}>Done</button>
                    </div>
                  </div>
                ) : (
                  <div className="gen-image-section" style={{ marginTop: 16 }}>
                    <span className="mini-label">Post Image</span>
                    {!(editForm.imagePaths || []).length ? (
                        <button className="btn btn-ghost btn-sm" onClick={() => setPickerMode('picker')}><Icon.Image width={14} height={14} /> Add Image</button>
                    ) : (
                        <div className="att-strip">
                          {(editForm.imagePaths || []).map(url => {
                            const libPhoto = photos.find(ph => ph.url === url) || { url, title: 'Image' }
                            return (
                              <div key={url} className="att-thumb">
                                <img src={url} alt="Attached" title="Click to view full size" onClick={() => setPreviewImage(libPhoto)} />
                                <button className="att-x" onClick={() => removeImage(url)} aria-label="Remove image">✕</button>
                              </div>
                            )
                          })}
                          <button className="att-add" onClick={() => setPickerMode('picker')} title="Add more images"><Icon.Plus width={18} height={18} /></button>
                        </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="gen-preview-wrap">
                <PostPreview client={client} platform={editPost.platform} format={editForm.format} draft={draft} visual={visual} photos={photos} topic={editForm.title} />
              </div>
            )}

            <div className="modal-actions modal-actions-sticky">
              <button className="btn btn-ghost" onClick={() => setEditPost(null)} disabled={savingEdit}>Cancel</button>
              <button className="btn btn-primary" onClick={saveEdit} disabled={savingEdit || !editForm.title.trim()}>{savingEdit ? 'Saving…' : 'Save changes'}</button>
            </div>
          </Modal>
        )
      })()}

      {confirmTarget && (
        <Modal title="Delete this post?" onClose={() => !deleting && setConfirmTarget(null)}>
          <div className="confirm-body">
            <span className="confirm-icon"><Icon.Trash width={20} height={20} /></span>
            <p className="confirm-text"><strong>“{confirmTarget.title || 'Untitled'}”</strong> ({platformById(confirmTarget.platform)?.name || confirmTarget.platform}) will be permanently removed. This can’t be undone.</p>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirmTarget(null)} disabled={deleting}>Cancel</button>
            <button className="btn btn-danger" onClick={confirmDelete} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete post'}</button>
          </div>
        </Modal>
      )}

      {/* Same bare lightbox as the photo library - one preview treatment app-wide. */}
      {previewImage && (
        <Modal className="modal-lightbox" onClose={() => setPreviewImage(null)}>
          <img className="lightbox-img" src={previewImage.url} alt={previewImage.title || 'Image'} />
        </Modal>
      )}

      {viewStats && (
        <PostStatsModal post={viewStats} onClose={() => setViewStats(null)} />
      )}
    </div>
  )
}
