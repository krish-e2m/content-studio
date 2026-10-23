import { useEffect, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Icon } from '../icons.jsx'
import { Modal } from '../components/Modal.jsx'
import { GallerySkeleton } from '../components/Skeleton.jsx'
import AIImageStudio from '../components/AIImageStudio.jsx'

const fmtDate = (iso) => {
  if (!iso) return 'Uploaded'
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) }
  catch { return 'Uploaded' }
}

// Only these raster formats are allowed - JPG/JPEG/PNG/WEBP/GIF, nothing else.
// `accept` limits the native picker; isAllowedImage catches drag/other paths.
// Extension is the reliable browser signal (some picks report an empty type);
// the server re-checks mimetype + extension strictly and is authoritative.
const PHOTO_ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,image/jpeg,image/png,image/webp,image/gif'
const ALLOWED_EXT = /\.(jpe?g|png|webp|gif)$/i
const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'])
const isAllowedImage = (f) => ALLOWED_EXT.test(f.name) || ALLOWED_MIME.has((f.type || '').toLowerCase())

export default function PhotoLibraryPage() {
  const { client, photos, photosReady, addPhoto, addGeneratedPhoto, removePhoto, removePhotos, reorderPhotos, flash } = useOutletContext()
  const [uploading, setUploading] = useState(0) // count of in-flight uploads
  const [studioOpen, setStudioOpen] = useState(false)

  const [confirmTarget, setConfirmTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState(() => new Set()) // selected photo ids
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [deletingBulk, setDeletingBulk] = useState(false)
  const [previewPhoto, setPreviewPhoto] = useState(null)

  // Local drag order - mirrors context photos, but reorders live during a drag
  // (context/DB is only updated on drop). Re-syncs whenever photos change.
  const [order, setOrder] = useState(photos)
  const [draggingId, setDraggingId] = useState(null)
  const dragId = useRef(null)
  useEffect(() => { setOrder(photos) }, [photos])

  const onDragStart = (id) => (e) => {
    dragId.current = id
    setDraggingId(id)
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', id) } catch { /* Safari */ }
  }
  const onDragOver = (overId) => (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const from = dragId.current
    if (from == null || from === overId) return
    setOrder((list) => {
      const fromIdx = list.findIndex((p) => p.id === from)
      const overIdx = list.findIndex((p) => p.id === overId)
      if (fromIdx < 0 || overIdx < 0 || fromIdx === overIdx) return list
      const next = list.slice()
      const [moved] = next.splice(fromIdx, 1)
      next.splice(overIdx, 0, moved)
      return next
    })
  }
  const onDragEnd = () => {
    dragId.current = null
    setDraggingId(null)
    // persist only if the order actually changed
    const before = photos.map((p) => p.id).join(',')
    const after = order.map((p) => p.id).join(',')
    if (before !== after) reorderPhotos(order.map((p) => p.id))
  }

  const allSelected = photos.length > 0 && selected.size === photos.length
  const toggleSelect = (id) =>
    setSelected((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(photos.map((p) => p.id)))
  const exitSelect = () => { setSelectMode(false); setSelected(new Set()) }

  const confirmBulkDelete = async () => {
    if (!selected.size || deletingBulk) return
    setDeletingBulk(true)
    await removePhotos([...selected])
    flash(`${selected.size} photo${selected.size === 1 ? '' : 's'} removed`)
    setDeletingBulk(false)
    setConfirmBulk(false)
    exitSelect()
  }

  // Upload each picked image in turn (server stores the file + a metadata row).
  const onUpload = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    const images = files.filter(isAllowedImage)
    if (images.length < files.length) flash('Only JPG, PNG, WEBP or GIF images are allowed')
    if (!images.length) return

    setUploading((n) => n + images.length)
    let ok = 0
    for (const file of images) {
      try { await addPhoto(file); ok++ }
      catch (err) { flash(err.message || 'Upload failed') }
      finally { setUploading((n) => n - 1) }
    }
    if (ok) flash(`${ok} photo${ok > 1 ? 's' : ''} added`)
  }

  const confirmDelete = async () => {
    if (!confirmTarget || deleting) return
    setDeleting(true)
    await removePhoto(confirmTarget.id)
    setDeleting(false)
    setConfirmTarget(null)
  }

  return (
    <div className="view">
      {/* Actions live in the page header, matching Idea Bank - the library's
          own controls shouldn't need a second toolbar row of their own. */}
      <div className="page-head page-head-row">
        <div>
          <span className="eyebrow">Asset library{photos.length ? ` · ${photos.length} photo${photos.length === 1 ? '' : 's'}` : ''}</span>
          <h1>Photo Library</h1>
          <p className="lede">Upload or generate images once, then reuse them across every post.</p>
        </div>

        <div className="page-head-actions">
          {!selectMode ? (
            <>
              {photos.length > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={() => setSelectMode(true)}>
                  <Icon.Check width={14} height={14} /> Select
                </button>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => setStudioOpen(true)}>
                <Icon.Spark width={14} height={14} /> Generate with AI
              </button>
              <label className={`btn btn-rose btn-sm pl-upload-btn ${uploading ? 'busy' : ''}`} title="JPG, PNG, WEBP or GIF">
                <Icon.Plus width={15} height={15} /> {uploading ? `Uploading ${uploading}…` : 'Upload photos'}
                <input type="file" accept={PHOTO_ACCEPT} multiple hidden disabled={!!uploading} onChange={onUpload} />
              </label>
            </>
          ) : (
            <>
              <span className="pl-hint">{selected.size} selected</span>
              <button className="btn btn-ghost btn-sm" onClick={toggleSelectAll}>{allSelected ? 'Clear all' : 'Select all'}</button>
              <button className="btn btn-ghost btn-sm" onClick={exitSelect}>Cancel</button>
              <button className="btn btn-danger btn-sm" disabled={!selected.size} onClick={() => setConfirmBulk(true)}>
                <Icon.Trash width={14} height={14} /> Delete{selected.size ? ` (${selected.size})` : ''}
              </button>
            </>
          )}
        </div>
      </div>

      {/* CSS column masonry: tight packing, every photo at its true aspect ratio */}
      {!photosReady ? (
        <GallerySkeleton count={9} />
      ) : (
      <div className="pl-gallery">
        {order.map((ph) => {
          const isSel = selected.has(ph.id)
          const canDrag = !selectMode
          return (
            <figure
              className={`pl-item ${selectMode ? 'selectable' : ''} ${isSel ? 'selected' : ''} ${canDrag ? 'draggable' : ''} ${draggingId === ph.id ? 'dragging' : ''}`}
              key={ph.id}
              draggable={canDrag}
              onClick={selectMode ? () => toggleSelect(ph.id) : () => setPreviewPhoto(ph)}
              onDragStart={canDrag ? onDragStart(ph.id) : undefined}
              onDragOver={canDrag ? onDragOver(ph.id) : undefined}
              onDrop={canDrag ? (e) => e.preventDefault() : undefined}
              onDragEnd={canDrag ? onDragEnd : undefined}
            >
              <img src={ph.url} alt={ph.title} loading="lazy" draggable={false} />
              {selectMode ? (
                <span className={`pl-check ${isSel ? 'on' : ''}`}>{isSel && <Icon.Check width={13} height={13} />}</span>
              ) : (
                <button className="pl-del" title="Delete photo" aria-label="Delete photo" onClick={(e) => { e.stopPropagation(); setConfirmTarget(ph); }}>
                  <Icon.Trash width={14} height={14} />
                </button>
              )}
              <figcaption className="meta">
                <div className="name" title={ph.title}>{ph.title || 'Untitled'}</div>
                <div className="sub">{fmtDate(ph.createdAt)}</div>
              </figcaption>
            </figure>
          )
        })}
      </div>
      )}

      {photosReady && photos.length === 0 && !uploading && (
        <p className="ob-hint" style={{ marginTop: 4 }}>No photos yet - upload your first, or generate one with AI, using the buttons above.</p>
      )}

      {studioOpen && (
        <AIImageStudio
          client={client}
          photos={photos}
          addGeneratedPhoto={addGeneratedPhoto}
          flash={flash}
          onClose={() => setStudioOpen(false)}
        />
      )}

      {confirmTarget && (
        <Modal title="Delete this photo?" onClose={() => !deleting && setConfirmTarget(null)}>
          <div className="confirm-body">
            <span className="confirm-icon"><Icon.Trash width={20} height={20} /></span>
            <p className="confirm-text">
              <strong>“{confirmTarget.title || 'This photo'}”</strong> will be permanently removed from the library. This can’t be undone.
            </p>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirmTarget(null)} disabled={deleting}>Cancel</button>
            <button className="btn btn-danger" onClick={confirmDelete} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete photo'}</button>
          </div>
        </Modal>
      )}

      {confirmBulk && (
        <Modal title={`Delete ${selected.size} photo${selected.size === 1 ? '' : 's'}?`} onClose={() => !deletingBulk && setConfirmBulk(false)}>
          <div className="confirm-body">
            <span className="confirm-icon"><Icon.Trash width={20} height={20} /></span>
            <p className="confirm-text">
              <strong>{selected.size} photo{selected.size === 1 ? '' : 's'}</strong> will be permanently removed from the library. This can’t be undone.
            </p>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirmBulk(false)} disabled={deletingBulk}>Cancel</button>
            <button className="btn btn-danger" onClick={confirmBulkDelete} disabled={deletingBulk}>{deletingBulk ? 'Deleting…' : `Delete ${selected.size}`}</button>
          </div>
        </Modal>
      )}

      {/* Bare lightbox: the photo on the scrim and nothing else - no card, fill,
          border or padding. The close button is the only chrome. */}
      {previewPhoto && (
        <Modal className="modal-lightbox" onClose={() => setPreviewPhoto(null)}>
          <img className="lightbox-img" src={previewPhoto.url} alt={previewPhoto.title || 'Photo'} />
        </Modal>
      )}
    </div>
  )
}
