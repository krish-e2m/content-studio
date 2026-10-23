import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons.jsx'
import { Modal } from './Modal.jsx'
import { PostPreview } from './PostPreview.jsx'
import { DatePicker } from './DatePicker.jsx'
import AIImageStudio from './AIImageStudio.jsx'
import { platformById, generateContent } from '../data.js'
import { iso, addDays, uid } from '../lib/util.js'
import { generatePostContent, generatePostContentFromImage } from '../api.js'

// Recover pillar marker written by ResearchPage.ideaFromSuggestion.
function parseIdeaMeta(note) {
  const raw = String(note || '')
  const m = raw.match(/\[Pillar:\s*([^\]]+)\]/i)
  const pillar = m ? m[1].trim() : ''
  const cleaned = raw
    .replace(/\[Pillar:\s*[^\]]+\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // Angle = note without pillar marker / trailing Source line (kept in note for humans).
  const angle = cleaned.replace(/\n\nSource:\s*\S[\s\S]*$/i, '').trim()
  return { pillar, angle, note: cleaned }
}

// One-shot content creation launched from an idea. No page, no wizard steps —
// a modal that: (1) asks "Generate" or "Generate from image", (2) optionally
// takes an image, (3) generates a tailored draft for EVERY platform the idea
// already targets (platform is never re-asked), (4) lets you preview/edit each
// draft, then (5) schedules them straight into the posts table.
//
// The uploaded image is stored in the Photo Library (the DB) via addPhoto, and
// its URL both grounds the generation and rides along as the post's image_paths.
export function GeneratePostModal({ client, idea, photos, addPhoto, addGeneratedPhoto, savePostBatch, setScheduled, onScheduled, onClose, flash, initialFormatByPlat, initialImagePhotos, autoStart }) {
  // Platforms come from the idea (chosen when it was captured) — never re-asked.
  const platforms = useMemo(() => {
    const valid = (idea.platforms || []).filter((p) => platformById(p))
    return valid.length ? valid : ['linkedin']
  }, [idea])
  // Content type (format) per platform — seeded from any selection made in the
  // Add-idea modal, else each platform's first format; editable before generating.
  const [formatByPlat, setFormatByPlat] = useState(() =>
    Object.fromEntries(platforms.map((pid) => [pid, (initialFormatByPlat && initialFormatByPlat[pid]) || platformById(pid)?.formats?.[0] || ''])),
  )

  const topic = idea.title || ''
  const { pillar: ideaPillar, angle: ideaAngle, note } = useMemo(() => parseIdeaMeta(idea.note || ''), [idea.note])
  const ideaTags = idea.tags || []
  const ideaHashtags = ideaTags
    .map((t) => '#' + String(t).replace(/[^a-zA-Z0-9]+/g, ''))
    .filter((h) => h.length > 1)
    .join(' ')

  const [stage, setStage] = useState(autoStart ? 'generating' : 'type') // type | generating | review
  const [imagePhotos, setImagePhotos] = useState(() => (Array.isArray(initialImagePhotos) ? initialImagePhotos : [])) // chosen image { id, url, title }
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false) // drop-zone hover state
  const [visibleCount, setVisibleCount] = useState(8) // library thumbnails rendered; grows on demand
  const [draftByPlat, setDraftByPlat] = useState({}) // pid -> { body, hashtags }
  const [tab, setTab] = useState(platforms[0])
  const [tabView, setTabView] = useState('edit') // 'edit' | 'preview'
  const [date, setDate] = useState(iso(addDays(new Date(), 1)))
  const [sameDate, setSameDate] = useState(true) // one publish date for all platforms
  const [dateByPlat, setDateByPlat] = useState({}) // per-platform dates (when sameDate is off)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef(null)

  // New state for adding image in review stage
  const [pickerMode, setPickerMode] = useState(null) // 'options' | 'library' | null
  const [showAiStudio, setShowAiStudio] = useState(false)
  const [previewImage, setPreviewImage] = useState(false)
  const [instruction, setInstruction] = useState('') // extra guidance for "regenerate with instruction"
  const [showInstruct, setShowInstruct] = useState(false)

  const activeTab = platforms.includes(tab) ? tab : platforms[0]
  // Resolve the publish date for a platform: shared date, or its own when the
  // "same date" toggle is off.
  const dateFor = (pid) => (sameDate || platforms.length === 1 ? date : (dateByPlat[pid] || date))
  const draft = draftByPlat[activeTab] || { body: '', hashtags: '' }
  const setDraftField = (pid, field, val) =>
    setDraftByPlat((m) => ({ ...m, [pid]: { ...(m[pid] || { body: '', hashtags: '' }), [field]: val } }))

  // The visual attached to every draft (image mode only) — reused for the
  // preview and stored on the scheduled post.
  const visual = imagePhotos.length > 0
    ? { path: 'photo', photoIds: imagePhotos.map(p => p.id), src: imagePhotos[0].url, prompt: '' }
    : { path: null, photoIds: [], src: '', prompt: '' }

  // Generate a tailored draft per platform. `imageUrl` set → the image-grounded
  // path; otherwise the brand-voice text path. An optional `instruction` is
  // folded into the note so "regenerate with instruction" steers the rewrite.
  // `polish` bumps long-form (or explicit stronger rewrite) to Sonnet.
  // Either way, a failed platform falls back to the local template so the flow
  // never dead-ends.
  const runGenerate = async (imageUrl, instructionText = '', { polish } = {}) => {
    setStage('generating')
    setError('')
    const genNote = instructionText.trim()
      ? [note, `Revision instruction: ${instructionText.trim()}`].filter(Boolean).join('\n\n')
      : note
    let fellBack = 0
    let totalCost = 0
    let costKnown = false
    try {
      const entries = await Promise.all(platforms.map(async (pid) => {
        const format = formatByPlat[pid]
        try {
          const payload = {
            topic,
            note: genNote,
            platform: pid,
            format,
            pillar: ideaPillar,
            angle: ideaAngle || undefined,
            ...(polish === true ? { polish: true } : {}),
          }
          const c = imageUrl
            ? await generatePostContentFromImage(client.id, { ...payload, imageUrl })
            : await generatePostContent(client.id, payload)
          const body = (c.body || '').replace(/^__SUBJECT__/, 'Subject: ')
          if (!body.trim()) throw new Error('empty draft')
          if (typeof c.costUsd === 'number') {
            totalCost += c.costUsd
            costKnown = true
          }
          return [pid, { body, hashtags: ideaHashtags, costUsd: c.costUsd, model: c.model }]
        } catch {
          fellBack++
          const c = generateContent({ topic, note: genNote, platform: pid, format })
          return [pid, { body: c.body.replace(/^__SUBJECT__/, 'Subject: '), hashtags: ideaHashtags }]
        }
      }))
      setDraftByPlat(Object.fromEntries(entries))
      setTab(platforms[0])
      setTabView('edit')
      setStage('review')
      if (fellBack === platforms.length) flash?.('AI unavailable — used template drafts. Check the server AI keys.')
      else if (fellBack > 0) flash?.('Some drafts used templates (AI hiccup) — the rest use your brand voice.')
      else if (costKnown) flash?.(`Content generated · $${totalCost.toFixed(4)}`)
      if (costKnown) console.log(`[content] client UI · ${platforms.length} platform(s) · $${totalCost.toFixed(4)}${polish ? ' · polish' : ''}`)
    } catch (e) {
      setError(e.message || 'Generation failed')
      setStage('type')
    }
  }

  // Launched from the Add-idea "Create content" button: content type + image were
  // already chosen there, so skip the type stage and generate immediately —
  // image-grounded when an image was added, otherwise the plain brand-voice path.
  // Guard with a ref so it fires exactly once — StrictMode double-invokes mount
  // effects in dev, which would otherwise run generation (a paid call) twice.
  const didAutoStart = useRef(false)
  useEffect(() => {
    if (autoStart && !didAutoStart.current) {
      didAutoStart.current = true
      runGenerate(imagePhotos.length ? imagePhotos[0].url : null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Upload files into the Photo Library (DB + Storage); the saved rows become
  // the selected images and also show up in the library grid below.
  const uploadFile = async (files) => {
    const fileList = Array.isArray(files) ? files : Array.from(files || [])
    if (!fileList.length) return
    setError('')
    setUploading(true)
    try {
      const savedPhotos = []
      for (const file of fileList) {
        const saved = await addPhoto(file, file.name)
        if (saved?.id) savedPhotos.push(saved)
      }
      if (savedPhotos.length > 0) {
        setImagePhotos(prev => {
          const newPhotos = savedPhotos.filter(sp => !prev.some(p => p.id === sp.id))
          return [...prev, ...newPhotos]
        })
      }
    } catch (err) {
      setError(err.message || 'Could not upload the images')
    } finally {
      setUploading(false)
    }
  }
  const onPickImage = (e) => { const files = e.target.files; if (!files?.length) return; uploadFile(files); e.target.value = ''; }
  const onDropImage = (e) => { e.preventDefault(); setDragOver(false); uploadFile(e.dataTransfer?.files) }
  
  // Reference existing Photo Library assets. Toggles selection.
  const toggleLibraryPhoto = (ph) => {
    setError('')
    setImagePhotos(prev => prev.some(p => p.id === ph.id) 
      ? prev.filter(p => p.id !== ph.id)
      : [...prev, { id: ph.id, url: ph.url, title: ph.title }]
    )
  }
  // Remove an image from selection
  const removeImage = (id) => setImagePhotos(prev => prev.filter(p => p.id !== id))
  const clearAllImages = () => setImagePhotos([])

  const handleReviewUpload = async (e) => {
    await onPickImage(e)
    setPickerMode(null)
  }

  const copy = (text) => navigator.clipboard?.writeText(text).then(() => flash?.('Copied to clipboard')).catch(() => flash?.('Copied'))

  // Finalize: write one 'scheduled' row per platform to the posts table, mirror
  // them into the in-memory calendar, refresh the Posts list, and close.
  const schedule = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    const batchId = crypto.randomUUID()
    const imagePaths = imagePhotos.map(p => p.url)
    const rows = platforms.map((pid) => ({
      platform: pid,
      title: topic.trim() || 'Untitled',
      content: draftByPlat[pid]?.body || '',
      note: note.trim(),
      format: formatByPlat[pid] || '',
      tags: ideaTags,
      imagePaths,
      imagePrompt: '',
      scheduledAt: dateFor(pid),
    }))
    try {
      await savePostBatch(batchId, rows, 'scheduled')
      const items = platforms.map((pid) => ({
        id: uid('sch'), ideaId: idea.id || null, title: topic.trim() || 'Untitled', note: note.trim(),
        platform: pid, format: formatByPlat[pid], date: dateFor(pid), body: draftByPlat[pid]?.body || '', hashtags: ideaHashtags,
        visual, imagePrompt: '', status: 'scheduled',
      }))
      setScheduled?.((s) => [...s, ...items])
      onScheduled?.()
      flash?.(`Scheduled · ${platforms.length} post${platforms.length > 1 ? 's' : ''}`)
      onClose()
    } catch (e) {
      setError(e.message || 'Could not schedule the posts')
      setBusy(false)
    }
  }

  const titles = {
    type: 'Create content',
    generating: 'Generating…',
    review: 'Review & schedule',
  }
  const subs = {
    type: 'Pick a content type per channel. Add an image to ground the drafts in what it shows, or leave it out to write from the idea.',
    generating: `Writing ${platforms.length} draft${platforms.length > 1 ? 's' : ''} in ${client.name || 'your'} brand voice…`,
    review: `${platforms.length} draft${platforms.length > 1 ? 's' : ''} · edit each, then pick a date and schedule.`,
  }

  return (
    <Modal wide={stage === 'review'} title={titles[stage]} sub={subs[stage]} onClose={onClose} className="gen-modal">
      {error && <div className="gen-error">{error}</div>}

      {/* ---- Stage 1: content type per channel + optional image, then generate ---- */}
      {stage === 'type' && (
        <>
          <input ref={fileRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={onPickImage} />

          <div className="gen-formats" style={{ marginBottom: 18 }}>
            <span className="mini-label">Content type · per channel</span>
            <div className="fmt-rows">
              {platforms.map((pid) => {
                const pp = platformById(pid)
                return (
                  <div className="fmt-row" key={pid}>
                    <span className="fmt-row-plat"><span className={`dot ${pp.dot}`} /> {pp.name}</span>
                    <div className="chip-row">
                      {pp.formats.map((f) => (
                        <button type="button" key={f} className={`chip ${formatByPlat[pid] === f ? 'on' : ''}`} onClick={() => setFormatByPlat((m) => ({ ...m, [pid]: f }))}>{f}</button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Optional image — provide one and the drafts are grounded in what it
              shows; leave it empty and they're written from the idea + brand voice. */}
          <div className="gen-image-section">
            <span className="mini-label">Add an image <span className="ais-opt">optional · grounds the drafts in what it shows</span></span>

            {imagePhotos.length > 0 ? (
              <div className="gen-selected">
                {imagePhotos.map(ph => (
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

            {/* Library grid — pick an existing photo. Only the first
                `visibleCount` are rendered; "Load more" reveals 8 at a time. */}
            {photos.length > 0 && (
              <div className="gen-lib">
                <span className="mini-label">Or pick from your Photo Library</span>
                <div className="gen-lib-grid">
                  {photos.slice(0, visibleCount).map((ph) => (
                    <button
                      type="button"
                      key={ph.id}
                      className={`gen-lib-item ${imagePhotos.some(p => p.id === ph.id) ? 'sel' : ''}`}
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

          <div className="modal-actions">
            <button className="btn btn-primary" disabled={uploading} onClick={() => runGenerate(imagePhotos.length ? imagePhotos[0].url : null)}>
              <Icon.Spark /> {uploading ? 'Uploading…' : imagePhotos.length ? `Generate from ${imagePhotos.length > 1 ? 'these images' : 'this image'}` : 'Generate'}
            </button>
          </div>
        </>
      )}

      {/* ---- Stage 3: generating ---- */}
      {stage === 'generating' && (
        <div className="gen-loading">
          <span className="suggest-spinner" />
          <p>{subs.generating}</p>
        </div>
      )}

      {/* ---- Stage 4: review + schedule ---- */}
      {stage === 'review' && (
        <>
          {platforms.length > 1 && (
            <div className="seg-tabs" style={{ marginBottom: 12 }}>
              {platforms.map((pid) => {
                const p = platformById(pid)
                return (
                  <button key={pid} className={`seg-tab ${activeTab === pid ? 'on' : ''}`} onClick={() => setTab(pid)}>
                    <span className={`dot ${p.dot}`} /> {p.name}
                  </button>
                )
              })}
            </div>
          )}

          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <div className="seg-tabs gen-view-tabs">
              <button className={`seg-tab ${tabView === 'edit' ? 'on' : ''}`} onClick={() => setTabView('edit')}><Icon.Pen width={13} height={13} /> Edit</button>
              <button className={`seg-tab ${tabView === 'preview' ? 'on' : ''}`} onClick={() => setTabView('preview')}><Icon.Eye width={14} height={14} /> Preview</button>
            </div>
            <span className="row" style={{ gap: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => copy(`${draft.body}${draft.hashtags ? '\n\n' + draft.hashtags : ''}`)}><Icon.Copy /> Copy</button>
              <button className="btn btn-ghost btn-sm" onClick={() => runGenerate(imagePhotos.length ? imagePhotos[0].url : null)} disabled={busy}><Icon.Spark /> Regenerate</button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => runGenerate(imagePhotos.length ? imagePhotos[0].url : null, instruction || 'Tighten voice, sharpen the angle, cut filler.', { polish: true })}
                disabled={busy}
                title="Rewrite with a stronger model (Sonnet) — costs more"
              >
                <Icon.Spark /> Stronger rewrite
              </button>
              <button className={`btn btn-ghost btn-sm ${showInstruct ? 'on' : ''}`} onClick={() => setShowInstruct((v) => !v)} disabled={busy}><Icon.Pen width={13} height={13} /> With instruction</button>
            </span>
          </div>

          {/* Regenerate with a custom instruction — folded into the note so the
              rewrite honours it, then reruns for every platform. */}
          {showInstruct && (
            <div className="gen-instruct">
              <input
                className="field"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="e.g. make it punchier, add a stat, more formal tone, shorter hook…"
                disabled={busy}
                onKeyDown={(e) => { if (e.key === 'Enter' && instruction.trim() && !busy) runGenerate(imagePhotos.length ? imagePhotos[0].url : null, instruction) }}
              />
              <button className="btn btn-rose btn-sm" disabled={busy || !instruction.trim()} onClick={() => runGenerate(imagePhotos.length ? imagePhotos[0].url : null, instruction)}>
                <Icon.Spark width={14} height={14} /> {busy ? 'Regenerating…' : 'Regenerate'}
              </button>
            </div>
          )}

          <span className="mini-label">{platformById(activeTab).name} · {formatByPlat[activeTab]}</span>
          
          {pickerMode === 'picker' ? (
            <div className="gen-formats" style={{ marginTop: 12 }}>
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
                       className={`gen-lib-item ${imagePhotos.some(p => p.id === ph.id) ? 'sel' : ''}`}
                       title={ph.title}
                       onClick={() => toggleLibraryPhoto(ph)}
                     >
                       <img src={ph.url} alt={ph.title || 'Photo'} loading="lazy" />
                     </button>
                  ))}
               </div>
               
               <div className="modal-actions" style={{ borderTop: 'none', padding: 0, marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowAiStudio(true)}><Icon.Spark width={14} height={14} /> Generate with AI</button>
                  <span style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-primary" onClick={() => setPickerMode(null)}>Done</button>
                  </span>
               </div>
            </div>
          ) : tabView === 'edit' ? (
            <>
              <textarea className="field" style={{ minHeight: 220, lineHeight: 1.6, fontSize: 14.5 }} value={draft.body} onChange={(e) => setDraftField(activeTab, 'body', e.target.value)} />
              {draft.hashtags !== '' && <input className="field hashtag-field" value={draft.hashtags} onChange={(e) => setDraftField(activeTab, 'hashtags', e.target.value)} />}
              
              <div className="gen-image-section" style={{ marginTop: 16 }}>
                 <span className="mini-label">Post Image</span>
                 {imagePhotos.length === 0 ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => setPickerMode('picker')}><Icon.Image width={14} height={14} /> Add Image</button>
                 ) : (
                    <div className="att-strip">
                       {imagePhotos.map(ph => (
                         <div key={ph.id} className="att-thumb">
                           <img src={ph.url} alt="Attached" title="Click to view full size" onClick={() => setPreviewImage(ph)} />
                           <button className="att-x" onClick={() => removeImage(ph.id)} aria-label="Remove image">✕</button>
                         </div>
                       ))}
                       <button className="att-add" onClick={() => setPickerMode('picker')} title="Add more images"><Icon.Plus width={18} height={18} /></button>
                    </div>
                 )}
              </div>
            </>
          ) : (
            <div className="gen-preview-wrap">
              <PostPreview key={activeTab} client={client} platform={activeTab} format={formatByPlat[activeTab]} draft={draft} visual={visual} photos={photos} topic={topic} />
            </div>
          )}

          <div className="gen-schedule">
            <div className="gen-schedule-head">
              <span className="mini-label" style={{ marginBottom: 0 }}>Schedule</span>
              {platforms.length > 1 && (
                <button type="button" className={`vis-toggle ${sameDate ? 'on' : ''}`} onClick={() => setSameDate((v) => !v)}>
                  <span className="vis-switch"><span className="vis-knob" /></span>
                  Same date for all {platforms.length} channels
                </button>
              )}
            </div>
            {sameDate || platforms.length === 1 ? (
              <>
                <span className="label">Publish date</span>
                <DatePicker value={date} onChange={setDate} disablePast style={{ maxWidth: 210 }} />
                <p className="muted-text" style={{ fontSize: 12.5, margin: '8px 0 0' }}>Schedules {platforms.length} post{platforms.length > 1 ? 's' : ''} — one per channel — on this date.</p>
              </>
            ) : (
              <div className="date-rows">
                {platforms.map((pid) => {
                  const pp = platformById(pid)
                  return (
                    <div className="date-row" key={pid}>
                      <span className="fmt-row-plat"><span className={`dot ${pp.dot}`} /> {pp.name}</span>
                      <DatePicker value={dateByPlat[pid] || date} onChange={(v) => setDateByPlat((m) => ({ ...m, [pid]: v }))} disablePast style={{ maxWidth: 200 }} />
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-rose" onClick={schedule} disabled={busy || !date}>
              {busy ? 'Scheduling…' : <>Schedule {platforms.length} post{platforms.length > 1 ? 's' : ''} <Icon.Arrow className="arrow" /></>}
            </button>
          </div>
        </>
      )}

      {showAiStudio && (
        <AIImageStudio
          client={client}
          photos={photos || []}
          addGeneratedPhoto={addGeneratedPhoto}
          flash={flash}
          onClose={() => setShowAiStudio(false)}
          onSaved={(photo) => {
            if (photo?.id && photo?.url) {
              setImagePhotos((arr) => (arr.some((p) => p.id === photo.id) ? arr : [...arr, photo]))
              setShowAiStudio(false)
              setPickerMode(null)
            }
          }}
        />
      )}

      {/* Bare lightbox, same as the photo library. The title is dropped with the
          card: a heading floating on the scrim labels an image that needs no label. */}
      {previewImage && (
        <Modal className="modal-lightbox" onClose={() => setPreviewImage(null)}>
          <img className="lightbox-img" src={previewImage.url} alt="Image" />
        </Modal>
      )}
    </Modal>
  )
}
