import { useMemo, useState } from 'react'
import { Modal } from './Modal.jsx'
import { Icon } from '../icons.jsx'
import { generateImages } from '../api.js'

// Guardrail dropdown vocab. The `id`s mirror the presets in server/images.js -
// the server maps each id to a fixed prompt fragment, so output stays on-brand
// and predictable rather than the model roaming free.
const STYLES = [
  { id: 'auto', label: 'Auto' },
  { id: 'photographic', label: 'Photographic' },
  { id: 'illustration', label: 'Flat illustration' },
  { id: 'render3d', label: '3D render' },
  { id: 'watercolor', label: 'Watercolor' },
  { id: 'lineart', label: 'Line art' },
  { id: 'minimalist', label: 'Minimalist' },
  { id: 'cinematic', label: 'Cinematic' },
  { id: 'isometric', label: 'Isometric' },
  { id: 'infographic', label: 'Infographic' },
]
// Text-first styles skip photo-era controls (composition, lighting).
const TEXT_STYLE_IDS = new Set(['infographic'])
const COMPOSITIONS = [
  { id: 'auto', label: 'Auto' },
  { id: 'closeup', label: 'Close-up' },
  { id: 'portrait', label: 'Portrait / headshot' },
  { id: 'wide', label: 'Wide establishing' },
  { id: 'flatlay', label: 'Flat lay' },
  { id: 'product', label: 'Product shot' },
]
const MOODS = [
  { id: 'auto', label: 'Auto' },
  { id: 'bright', label: 'Bright & airy' },
  { id: 'moody', label: 'Moody' },
  { id: 'warm', label: 'Warm' },
  { id: 'studio', label: 'Studio' },
  { id: 'natural', label: 'Natural light' },
  { id: 'highcontrast', label: 'High contrast' },
]
const ASPECTS = [
  { id: 'square', label: 'Square · 1:1' },
  { id: 'portrait', label: 'Portrait · 4:5' },
  { id: 'story', label: 'Story · 9:16' },
  { id: 'landscape', label: 'Landscape · 16:9' },
]
const COUNTS = [1, 2, 3, 4]
const MAX_REFS = 4

// Downscale an uploaded image in the browser before sending it as a reference:
// keeps the request small (full-res photos as base64 can blow past the API body
// limit with several refs) and speeds up generation. Portrait/likeness mode keeps
// a bit more detail (1536) so faces stay usable.
function fileToScaledDataUrl(file, maxDim = 1280, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const objUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(objUrl)
      try {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', quality))
      } catch (err) {
        reject(err)
      }
    }
    img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('Could not read image')) }
    img.src = objUrl
  })
}

// A short title derived from the prompt (first handful of words).
const titleFromPrompt = (p) => {
  const words = String(p || '').trim().split(/\s+/).slice(0, 7).join(' ')
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'AI generated image'
}

export default function AIImageStudio({ client, photos = [], addGeneratedPhoto, flash, onClose, onSaved }) {
  const [prompt, setPrompt] = useState('')
  const [style, setStyle] = useState('photographic')
  const [composition, setComposition] = useState('auto')
  const [mood, setMood] = useState('auto')
  const [aspect, setAspect] = useState('square')
  const [count, setCount] = useState(1)
  const [avoid, setAvoid] = useState('')
  const [usePalette, setUsePalette] = useState(true)
  const [addLogo, setAddLogo] = useState(false) // include the brand logo in the image?
  const [references, setReferences] = useState([]) // { id, url, name, source }
  const [showLib, setShowLib] = useState(false)

  const [generating, setGenerating] = useState(false)
  const [results, setResults] = useState([]) // { id, dataUrl }
  const [saved, setSaved] = useState(() => new Set())
  const [savingId, setSavingId] = useState(null)
  const [error, setError] = useState('')

  // Brand palette from the client's Brand Brain (primary + supporting hexes),
  // de-duped; falls back to the client's derived accent so the toggle is useful
  // even before a full brand extraction.
  const brandColors = useMemo(() => {
    const c = client?.ref_documents?.identity?.colors || {}
    const list = [...(c.primary || []), ...(c.supporting || [])]
      .map((x) => (typeof x?.hex === 'string' ? x.hex.trim() : ''))
      .filter((h) => /^#[0-9a-fA-F]{3,8}$/.test(h))
    const uniq = [...new Map(list.map((h) => [h.toLowerCase(), h])).values()]
    if (!uniq.length && client?.accent) uniq.push(client.accent)
    return uniq.slice(0, 8)
  }, [client])

  const canGenerate = prompt.trim().length > 0 && !generating
  const refUrls = new Set(references.map((r) => r.url))
  const refMaxDim = composition === 'portrait' ? 1536 : 1280

  const removeRef = (id) => setReferences((r) => r.filter((x) => x.id !== id))

  const onRefUpload = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    let room = MAX_REFS - references.length
    if (room <= 0) return flash?.(`Up to ${MAX_REFS} reference images`)
    for (const f of files) {
      if (room <= 0) { flash?.(`Up to ${MAX_REFS} reference images`); break }
      if (!f.type.startsWith('image/')) { flash?.('Reference files must be images'); continue }
      try {
        const url = await fileToScaledDataUrl(f, refMaxDim)
        room--
        setReferences((r) =>
          r.length >= MAX_REFS
            ? r
            : [...r, { id: `up-${Date.now()}-${f.name}-${r.length}`, url, name: f.name, source: 'upload' }],
        )
      } catch {
        flash?.('Could not add that reference image')
      }
    }
  }

  const toggleLibRef = (photo) => {
    setReferences((r) => {
      const existing = r.find((x) => x.url === photo.url)
      if (existing) return r.filter((x) => x.url !== photo.url)
      if (r.length >= MAX_REFS) {
        flash?.(`Up to ${MAX_REFS} reference images`)
        return r
      }
      return [...r, { id: `lib-${photo.id}`, url: photo.url, name: photo.title || 'Photo', source: 'library' }]
    })
  }

  const doGenerate = async () => {
    if (!prompt.trim()) return setError('Describe the image you want first.')
    setError('')
    setGenerating(true)
    setResults([])
    setSaved(new Set())
    try {
      const out = await generateImages(client.id, {
        prompt: prompt.trim(),
        style,
        composition,
        lighting: mood,
        aspect,
        count,
        avoid: avoid.trim(),
        brandColors: usePalette ? brandColors : [],
        logo: addLogo,
        references: references.map((r) => r.url),
      })
      setResults((out.images || []).map((dataUrl, i) => ({ id: `g-${Date.now()}-${i}`, dataUrl })))
      if (!out.images?.length) setError('No images were returned - try again or tweak the prompt.')
    } catch (e) {
      setError(e.message || 'Image generation failed')
    } finally {
      setGenerating(false)
    }
  }

  const saveOne = async (r) => {
    if (saved.has(r.id) || savingId) return
    setSavingId(r.id)
    try {
      const photo = await addGeneratedPhoto({ dataUrl: r.dataUrl, title: titleFromPrompt(prompt), prompt: prompt.trim() })
      setSaved((s) => new Set(s).add(r.id))
      flash?.('Saved to Photo Library')
      onSaved?.(photo)
    } catch (e) {
      setError(e.message || 'Could not save to library')
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Modal
      title="Generate with AI"
      sub="Describe a visual, steer it with the guardrails, and save the ones you like to this client's library."
      wide
      className="modal-studio"
      onClose={onClose}
    >
      <div className="ais">
        {/* ---------- controls ---------- */}
        <div className="ais-controls">
          <div className="ais-controls-scroll">
          <div className="ais-block">
            <span className="modal-label">Describe your image</span>
            <textarea
              className="field"
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Be specific: subject + setting + lighting. e.g. Sharp product photo of a laptop on a clean desk showing an AI dashboard, soft studio light, pin-sharp focus"
            />
          </div>

          <div className="ais-grid2">
            <label className="ais-block">
              <span className="modal-label">Style</span>
              <select className="field" value={style} onChange={(e) => setStyle(e.target.value)}>
                {STYLES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
            <label className="ais-block">
              <span className="modal-label">Composition</span>
              <select className="field" value={TEXT_STYLE_IDS.has(style) ? 'auto' : composition} onChange={(e) => setComposition(e.target.value)} disabled={TEXT_STYLE_IDS.has(style)} title={TEXT_STYLE_IDS.has(style) ? 'Not used for infographic style' : ''}>
                {COMPOSITIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
            <label className="ais-block">
              <span className="modal-label">Mood / Light</span>
              <select className="field" value={TEXT_STYLE_IDS.has(style) ? 'auto' : mood} onChange={(e) => setMood(e.target.value)} disabled={TEXT_STYLE_IDS.has(style)} title={TEXT_STYLE_IDS.has(style) ? 'Not used for infographic style' : ''}>
                {MOODS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
            <label className="ais-block">
              <span className="modal-label">Aspect ratio</span>
              <select className="field" value={aspect} onChange={(e) => setAspect(e.target.value)}>
                {ASPECTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
            <label className="ais-block">
              <span className="modal-label">Variations</span>
              <select className="field" value={count} onChange={(e) => setCount(Number(e.target.value))}>
                {COUNTS.map((n) => <option key={n} value={n}>{n} image{n > 1 ? 's' : ''}</option>)}
              </select>
            </label>
          </div>

          {composition === 'portrait' && (
            <p className="ais-note" style={{ margin: '0 0 8px' }}>
              Portrait mode: attach a face/reference photo for likeness. Brand colors accent only — skin stays natural.
            </p>
          )}

          {/* on-brand palette guardrail */}
          {brandColors.length > 0 && (
            <button
              type="button"
              className={`ais-brand ${usePalette ? 'on' : ''}`}
              onClick={() => setUsePalette((v) => !v)}
              title="Steer the image toward this client's brand colors"
            >
              <span className={`ais-check ${usePalette ? 'on' : ''}`}>{usePalette && <Icon.Check width={11} height={11} />}</span>
              <span className="ais-brand-label">Use on-brand colors</span>
              <span className="ais-swatches">
                {brandColors.slice(0, 6).map((hex) => (
                  <span key={hex} className="ais-swatch" style={{ background: hex }} title={hex} />
                ))}
              </span>
            </button>
          )}

          {/* add-logo toggle switch */}
          <div className="ais-switch-row">
            <span className="ais-switch-label">
              Add logo
              <em>{addLogo ? "this client's logo, placed top-right by default" : 'no logo will be added'}</em>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={addLogo}
              aria-label="Add logo to the generated image"
              className={`ais-switch ${addLogo ? 'on' : ''}`}
              onClick={() => setAddLogo((v) => !v)}
            >
              <span className="ais-switch-knob" />
            </button>
          </div>

          {/* reference images */}
          <div className="ais-block">
            <span className="modal-label">Reference images <span className="ais-opt">optional · up to {MAX_REFS}</span></span>
            <div className="ais-ref-strip">
              {references.map((r) => (
                <span className="ais-ref" key={r.id} title={r.name}>
                  <img src={r.url} alt={r.name} />
                  <button className="ais-ref-x" onClick={() => removeRef(r.id)} aria-label="Remove reference">✕</button>
                </span>
              ))}
              {references.length < MAX_REFS && (
                <>
                  <label className="ais-ref-add" title="Upload a reference image">
                    <Icon.Plus width={16} height={16} />
                    <input type="file" accept="image/*" multiple hidden onChange={onRefUpload} />
                  </label>
                  {photos.length > 0 && (
                    <button
                      type="button"
                      className={`ais-ref-lib ${showLib ? 'on' : ''}`}
                      onClick={() => setShowLib((v) => !v)}
                      title="Pick from the Photo Library"
                    >
                      <Icon.Image width={15} height={15} /> Library
                    </button>
                  )}
                </>
              )}
            </div>

            {showLib && photos.length > 0 && (
              <div className="ais-lib">
                {photos.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`ais-lib-item ${refUrls.has(p.url) ? 'on' : ''}`}
                    onClick={() => toggleLibRef(p)}
                    title={p.title}
                  >
                    <img src={p.url} alt={p.title} loading="lazy" />
                    {refUrls.has(p.url) && <span className="ais-lib-check"><Icon.Check width={12} height={12} /></span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <label className="ais-block">
            <span className="modal-label">Avoid <span className="ais-opt">optional</span></span>
            <input
              className="field"
              value={avoid}
              onChange={(e) => setAvoid(e.target.value)}
              placeholder="e.g. text, clutter, harsh shadows"
            />
          </label>

          </div>{/* /ais-controls-scroll */}

          <div className="ais-controls-foot">
            <button className="btn btn-rose ais-go" disabled={!canGenerate} onClick={doGenerate}>
              <Icon.Spark width={15} height={15} />
              {generating ? 'Generating…' : results.length ? 'Generate again' : 'Generate'}
            </button>
            {error && <p className="ais-error">⚠ {error}</p>}
          </div>
        </div>

        {/* ---------- results ---------- */}
        <div className="ais-results">
          {generating &&
            Array.from({ length: count }).map((_, i) => <div className="ais-skeleton" key={i} />)}

          {!generating && results.length > 0 && (
            <>
              {results.map((r) => (
                <figure className="ais-result" key={r.id}>
                  <img src={r.dataUrl} alt="Generated" />
                  <div className="ais-result-actions">
                    <button
                      className="btn btn-rose btn-sm"
                      onClick={() => saveOne(r)}
                      disabled={saved.has(r.id) || savingId === r.id}
                    >
                      {saved.has(r.id) ? <><Icon.Check width={14} height={14} /> Saved</> : savingId === r.id ? 'Saving…' : <><Icon.Plus width={14} height={14} /> Save</>}
                    </button>
                    <a className="btn btn-ghost btn-sm" href={r.dataUrl} download={`${titleFromPrompt(prompt).replace(/\s+/g, '-').toLowerCase()}.png`}>
                      Download
                    </a>
                  </div>
                </figure>
              ))}
              <p className="ais-note">Saved images appear in this client's Photo Library, ready to pair with a post.</p>
            </>
          )}

          {!generating && results.length === 0 && (
            <div className="ais-empty">
              <span className="ais-empty-ico"><Icon.Image width={26} height={26} /></span>
              <p>Your generated visuals will appear here.</p>
              <span className="ais-empty-sub">Set the guardrails, describe the image, then hit Generate.</span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
