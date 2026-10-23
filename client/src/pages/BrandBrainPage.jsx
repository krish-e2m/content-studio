import { useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { Icon } from '../icons.jsx'
import { Modal } from '../components/Modal.jsx'
import { ChromeShell } from '../components/ChromeShell.jsx'
import { VoiceEditor } from '../components/VoiceEditor.jsx'
import { IdentityEditor } from '../components/IdentityEditor.jsx'
import { LogoControl } from '../components/LogoControl.jsx'
import { ClientLogo } from '../components/ClientLogo.jsx'
import { BrainLoading } from '../components/BrainLoading.jsx'
import { BrandDocuments } from '../components/BrandDocuments.jsx'
import { useClients } from '../context/ClientsContext.jsx'
import { colorFor, slugify, SOCIAL_OPTIONS, platformHasHandle } from '../data.js'
import { updateClient, uploadDocument, fetchLogo, uploadLogo, extractBrand, extractBrandPdf, extractBrandSiteLive } from '../api.js'
import { decorateClient, clientToDraft, buildClientFields, mergeExtraction, applyBrowserBranding, platformName, povName } from '../lib/clientModel.js'
import { useGoogleFonts, normalizeUrl } from '../lib/util.js'

// Tab-panel motion: the whole section blurs/slides in, and its cards stagger.
const panelV = {
  hidden: { opacity: 0, y: 14, filter: 'blur(8px)' },
  show: {
    opacity: 1, y: 0, filter: 'blur(0px)',
    transition: { duration: 0.36, ease: [0.22, 1, 0.36, 1], staggerChildren: 0.07, delayChildren: 0.05 },
  },
  exit: { opacity: 0, y: -12, filter: 'blur(8px)', transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } },
}
const cardV = {
  hidden: { opacity: 0, y: 18, scale: 0.98 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.34, ease: [0.22, 1, 0.36, 1] } },
}
const TABS = [['details', 'Client details'], ['guideline', 'Brand guideline'], ['documents', 'Brand documents']]

// Route element: resolve the client, then render the brand-brain editor inside
// the standard chrome shell.
export default function BrandBrainPage() {
  const { clientId } = useParams()
  const { clients, setClients } = useClients()
  const navigate = useNavigate()
  const client = clients.find((c) => String(c.id) === String(clientId))
  if (!client) return <Navigate to="/" replace />

  const onSaved = (updated) => {
    const dec = decorateClient(updated)
    setClients((arr) => (arr || []).map((c) => (c.id === dec.id ? dec : c)))
  }

  return (
    <ChromeShell crumb="Clients · Brand Brain" client={client}>
      <BrandBrainView
        key={client.id}
        client={client}
        onBack={() => navigate('/')}
        onOpen={(id) => navigate(`/clients/${id}`)}
        onSaved={onSaved}
      />
    </ChromeShell>
  )
}

function BrandBrainView({ client, onBack, onOpen, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [logoBusy, setLogoBusy] = useState(false)
  const [voiceDocBusy, setVoiceDocBusy] = useState(-1)
  const [err, setErr] = useState('')
  const [brandMode, setBrandMode] = useState('manual')
  const [extractUrl, setExtractUrl] = useState('')
  const [extractBusy, setExtractBusy] = useState(false)
  const [extractMsg, setExtractMsg] = useState('')
  const [extractLines, setExtractLines] = useState([]) // live progress from the browser extractor
  const [choosing, setChoosing] = useState(false)
  const [buildFlow, setBuildFlow] = useState(null) // null | 'manual' | 'auto'
  const [tab, setTab] = useState('details') // 'details' | 'guideline'
  const [editScope, setEditScope] = useState('details') // which tab the edit applies to
  const [extractKind, setExtractKind] = useState('site') // 'site' | 'pdf'

  const ref = client.ref_documents || {}
  const socials = client.social_media_accounts || []
  const voices = ref.voices || []
  const docs = ref.documents || []
  const accent = colorFor(client.slug || client.name)
  const logoSrc = (editing && draft ? (draft.ref.logo_manual || draft.ref.logo_scraped) : ref.logo_url) || ''
  // identity-derived view data
  const idn = ref.identity || {}
  const primarySwatches = (idn.colors?.primary || []).filter((c) => c && c.hex)
  const supportingSwatches = (idn.colors?.supporting || []).filter((c) => c && c.hex)
  const swatches = [...primarySwatches, ...supportingSwatches]
  const wmDonts = Array.isArray(idn.wordmark?.donts) ? idn.wordmark.donts.filter(Boolean) : []
  const fontList = Array.isArray(idn.typography?.fonts)
    ? idn.typography.fonts.filter((f) => f && f.family)
    : ['serif', 'sans', 'mono'].map((k) => idn.typography?.[k]).filter((f) => f && f.family)
  // load the brand's fonts so the view-mode type specimens render in the real face
  useGoogleFonts(fontList.map((f) => f.family))
  const hasGuideline = !!(
    ref.brand_tone || ref.mission || ref.keywords?.length || ref.avoid_words?.length ||
    ref.content_pillars?.length || voices.length || swatches.length || fontList.length || docs.length ||
    idn.positioning?.tagline || idn.positioning?.statement || idn.wordmark?.rules
  )

  const startEdit = (scope) => { setEditScope(scope); setDraft(clientToDraft(client)); setErr(''); setEditing(true) }
  // chooser → open the focused single-field modal for that flow
  const beginBuild = (flow) => { setChoosing(false); setErr(''); setExtractUrl(client.website_url || ''); setBuildFlow(flow) }
  // Automatic · AI: run the new headless-browser extractor (visual brand) and
  // the Groq pass (voice/tone) in PARALLEL, then merge into one ref. The
  // browser engine reads the REAL painted page, so its colors/fonts win;
  // Groq still owns voice/tone/mission/voices + positioning copy. The browser
  // extractor's step lines stream into the loader.
  // The LOGO deliberately comes from the manifest/icon service (fetchLogo →
  // manifest.im), NOT the browser scraper's DOM-guessed logo: it resolves the
  // site's declared web-app-manifest / apple-touch icon, which is cleaner and
  // more reliable than whatever <img> the scraper happens to pick out.
  const runAutoExtract = async (url, base) => {
    setExtractLines([])
    const groqP = extractBrand(url).then((r) => r.data).catch(() => null)
    const browserP = extractBrandSiteLive(url, (line) => setExtractLines((ls) => [...ls, line])).catch(() => null)
    const logoP = fetchLogo(url, base.ref.logo_scraped).then((r) => r.url).catch(() => '')
    const [groqData, browser, logoUrl] = await Promise.all([groqP, browserP, logoP])
    if (!groqData && !browser) throw new Error('Could not read that website.')

    let nextRef = base.ref
    if (groqData) nextRef = mergeExtraction(nextRef, groqData, url)

    if (browser?.branding) {
      // browser owns colors/fonts/positioning; logo comes from manifest.im
      nextRef = applyBrowserBranding(nextRef, browser.branding, url, logoUrl)
    } else if (logoUrl) {
      // no visual branding this run, but keep the manifest logo we fetched
      nextRef = { ...nextRef, logo_scraped: logoUrl }
    }

    const b = browser?.branding
    const pages = b?.pages_crawled?.length || (b ? 1 : 0)
    const msg = [
      b ? `${pages} page${pages === 1 ? '' : 's'} painted` : null,
      b ? `${b.colors?.all?.length || 0} colors` : null,
      logoUrl ? 'logo captured' : null,
      groqData ? 'voice drafted' : 'voice skipped',
    ].filter(Boolean).join(' · ')
    return { ref: nextRef, website_url: base.website_url || url, msg }
  }

  // AI from a website URL → loader → land in the editor with populated fields
  const onBuildUrl = async () => {
    const url = (extractUrl || client.website_url || '').trim()
    if (!url) { setErr('Enter the website URL first.'); return }
    setEditScope('guideline'); setExtractKind('site'); setBuildFlow(null); setExtractBusy(true); setErr('')
    try {
      const base = editing && draft ? draft : clientToDraft(client)
      const { ref, website_url, msg } = await runAutoExtract(url, base)
      setDraft({ ...base, website_url, ref })
      setBrandMode('auto'); setExtractMsg(`${msg} - review & tweak below.`)
      setEditing(true)
    } catch (e) { setErr(e.message || 'Extraction failed'); setBuildFlow('auto') } finally { setExtractBusy(false) }
  }
  // AI from an uploaded PDF → loader → land in the editor with populated fields
  const onBuildPdf = async (e) => {
    const file = (e.target.files || [])[0]
    e.target.value = ''
    if (!file) return
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { setErr('Only PDF files are allowed.'); return }
    setEditScope('guideline'); setExtractKind('pdf'); setBuildFlow(null); setExtractBusy(true); setErr('')
    try {
      const base = editing && draft ? draft : clientToDraft(client)
      const { data } = await extractBrandPdf(file)
      setDraft({ ...base, ref: mergeExtraction(base.ref, data, file.name) })
      setEditing(true)
    } catch (er) { setErr(er.message || 'PDF extraction failed'); setBuildFlow('manual') } finally { setExtractBusy(false) }
  }
  const cancel = () => { setEditing(false); setDraft(null); setErr('') }
  const save = async () => {
    setSaving(true); setErr('')
    try {
      const updated = await updateClient(client.id, buildClientFields(draft))
      onSaved?.(updated)
      setEditing(false); setDraft(null)
    } catch (e) {
      setErr(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // ---- edit-draft updaters ----
  const updRef = (patch) => setDraft((x) => ({ ...x, ref: { ...x.ref, ...patch } }))
  const setSocial = (i, k, val) => setDraft((x) => ({ ...x, social_media_accounts: x.social_media_accounts.map((s, j) => (j === i ? { ...s, [k]: val } : s)) }))
  const addSocial = () => setDraft((x) => ({ ...x, social_media_accounts: [...x.social_media_accounts, { platform: 'instagram', handle: '', url: '' }] }))
  const removeSocial = (i) => setDraft((x) => ({ ...x, social_media_accounts: x.social_media_accounts.filter((_, j) => j !== i) }))
  const setVoice = (i, k, val) => setDraft((x) => ({ ...x, ref: { ...x.ref, voices: x.ref.voices.map((v, j) => (j === i ? { ...v, [k]: val } : v)) } }))
  const addVoice = () => setDraft((x) => ({ ...x, ref: { ...x.ref, voices: [...x.ref.voices, { kind: 'custom', name: '', pov: 'brand_we', tone: '', dos: '', donts: '', samples: '', doc: null }] } }))
  const removeVoice = (i) => setDraft((x) => ({ ...x, ref: { ...x.ref, voices: x.ref.voices.filter((_, j) => j !== i) } }))
  const setPillar = (i, k, val) => setDraft((x) => ({
    ...x,
    ref: {
      ...x.ref,
      content_pillars: (x.ref.content_pillars || []).map((p, j) => (j === i ? { ...p, [k]: val } : p)),
    },
  }))
  const addPillar = () => setDraft((x) => ({
    ...x,
    ref: {
      ...x.ref,
      content_pillars: [...(x.ref.content_pillars || []), { name: '', description: '' }].slice(0, 6),
    },
  }))
  const removePillar = (i) => setDraft((x) => ({
    ...x,
    ref: { ...x.ref, content_pillars: (x.ref.content_pillars || []).filter((_, j) => j !== i) },
  }))
  const onUploadVoiceDoc = async (i, e) => {
    const file = (e.target.files || [])[0]
    e.target.value = ''
    if (!file) return
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { setErr('Only PDF files are allowed.'); return }
    setVoiceDocBusy(i); setErr('')
    try {
      const saved = await uploadDocument(file, slugify(draft.name) || slugify(client.name) || 'unfiled')
      setVoice(i, 'doc', { title: saved.title, path: saved.path, url: saved.url })
    } catch (er) { setErr(er.message || 'Upload failed') } finally { setVoiceDocBusy(-1) }
  }
  const grabLogo = async (url) => {
    const v = (url || '').trim()
    if (!v) return
    setLogoBusy(true)
    try {
      const { url: logoUrl } = await fetchLogo(v, draft.ref.logo_scraped)
      if (logoUrl) updRef({ logo_scraped: logoUrl })
    } catch {
      /* logo is optional - ignore failures */
    } finally {
      setLogoBusy(false)
    }
  }
  const onUploadLogo = async (e) => {
    const file = (e.target.files || [])[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { setErr('Logo must be an image file.'); return }
    setLogoBusy(true); setErr('')
    try {
      const { url } = await uploadLogo(file, slugify(draft.name) || slugify(client.name) || 'unfiled')
      if (url) updRef({ logo_manual: url })
    } catch (er) { setErr(er.message || 'Logo upload failed') } finally { setLogoBusy(false) }
  }
  const removeManualLogo = () => updRef({ logo_manual: '' })
  const runExtract = async () => {
    const url = (extractUrl || draft.website_url || client.website_url || '').trim()
    if (!url) { setErr('Enter the website URL first.'); return }
    setExtractKind('site'); setExtractBusy(true); setErr(''); setExtractMsg('')
    try {
      const { ref, website_url, msg } = await runAutoExtract(url, draft)
      setDraft((x) => ({ ...x, website_url: x.website_url || website_url, ref }))
      setExtractMsg(`${msg} - review & tweak below.`)
    } catch (e) { setErr(e.message || 'Extraction failed') } finally { setExtractBusy(false) }
  }
  // Manual mode: parse an uploaded brand-guide PDF and let AI fill the fields.
  const onUploadBrandPdf = async (e) => {
    const file = (e.target.files || [])[0]
    e.target.value = ''
    if (!file) return
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { setErr('Only PDF files are allowed.'); return }
    setExtractKind('pdf'); setExtractBusy(true); setErr(''); setExtractMsg('')
    try {
      const { data, meta } = await extractBrandPdf(file)
      setDraft((x) => ({ ...x, ref: mergeExtraction(x.ref, data, file.name) }))
      setExtractMsg(`Read ${meta.chars.toLocaleString()} chars · ${meta.colors.length} colors found - review & tweak below.`)
    } catch (er) { setErr(er.message || 'PDF extraction failed') } finally { setExtractBusy(false) }
  }

  // Brand documents owns its own add/edit/save flow, so the page-level edit
  // chrome (Edit / Save changes) is hidden while that tab is open.
  const onDocsTab = tab === 'documents'
  const showEditChrome = editing && !onDocsTab

  return (
    <div className="view">
      {/* action bar */}
      <div className="bb-top">
        {showEditChrome ? (
          <span className="eyebrow" style={{ alignSelf: 'center' }}>Editing client {editScope === 'guideline' ? 'guideline' : 'details'}</span>
        ) : (
          <button className="btn btn-ghost btn-sm" onClick={onBack}><Icon.Back /> All clients</button>
        )}
        {showEditChrome ? (
          <span className="row" style={{ gap: 10 }}>
            <button className="btn btn-ghost btn-sm" onClick={cancel} disabled={saving}>Cancel</button>
            <button className="btn btn-rose btn-sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
          </span>
        ) : (
          <span className="row" style={{ gap: 10 }}>
            {!onDocsTab && <button className="btn btn-ghost btn-sm" onClick={() => startEdit(tab)}><Icon.Pen width={15} height={15} /> Edit</button>}
            <button className="btn btn-rose btn-sm" onClick={() => onOpen(client.id)}>Open workspace <Icon.Arrow className="arrow" /></button>
          </span>
        )}
      </div>

      {/* hero */}
      <div className="bp-hero">
        <ClientLogo className="bp-hero-logo" src={logoSrc} fallback={(client.name || '?').charAt(0)} fallbackStyle={{ background: accent }} surface="dark" />
        <div className="bp-hero-body">
          <span className="bp-hero-eyebrow">Brand guideline · {client.status || 'onboarding'}</span>
          <h1 className="bp-hero-name">{client.name}</h1>
          {client.tagline && <p className="bp-hero-tag">{client.tagline}</p>}
          <div className="bp-hero-meta">
            <span className="bp-chip-dark">ID · {client.slug}</span>
            {client.industry && <span className="bp-chip-dark">{client.industry}</span>}
            <span className="bp-chip-dark">{socials.length} channel{socials.length === 1 ? '' : 's'}</span>
          </div>
        </div>
      </div>

      {err && <div className="lock-note" style={{ marginBottom: 18 }}>{err}</div>}

      {/* KPI cards + tabs - shown in both view and edit mode */}
      <div className="bp-stats">
        <div className="bp-stat"><div className="num bp-stat-text">{client.industry || '-'}</div><div className="lbl">Industry</div></div>
        <div className="bp-stat"><div className="num">{socials.length}</div><div className="lbl">Channels</div></div>
        <div className="bp-stat"><div className="num">{voices.length}</div><div className="lbl">Voices</div></div>
        <div className="bp-stat"><div className="num">{swatches.length}</div><div className="lbl">Brand colors</div></div>
      </div>

      <div className="bp-tabs">
        {TABS.map(([key, label]) => {
          const active = editing ? editScope : tab
          return (
            <motion.button
              key={key}
              className={`bp-tab ${active === key ? 'on' : ''}`}
              onClick={() => { setTab(key); setEditScope(key) }}
              whileTap={{ scale: 0.94 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            >
              {active === key && (
                <motion.span
                  layoutId="bp-tab-pill"
                  className="bp-tab-pill"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
              <span className="bp-tab-label">{label}</span>
            </motion.button>
          )
        })}
      </div>

      {onDocsTab ? (
        /* ===================== BRAND DOCUMENTS ===================== */
        <BrandDocuments client={client} onSaved={onSaved} />
      ) : editing && draft ? (
        /* ===================== EDIT MODE ===================== */
        <AnimatePresence mode="wait" initial={false}>
          {editScope === 'details' && (
          <motion.div key="edit-details" className="bb-grid" variants={panelV} initial="hidden" animate="show" exit="exit">
          <motion.div className="card bb-card" style={{ gridColumn: '1 / -1' }} variants={cardV}>
            <span className="eyebrow">Identity</span>
            <h2 className="bb-h2">Basics</h2>
            <div className="ob-grid">
              <div className="ob-field"><span className="mini-label">Client / brand name *</span><input className="field" value={draft.name} onChange={(e) => setDraft((x) => ({ ...x, name: e.target.value }))} /></div>
              <div className="ob-field"><span className="mini-label">ID / slug · auto, not editable</span><input className="field" value={client.slug} disabled readOnly style={{ opacity: 0.6, fontFamily: 'var(--mono)', fontSize: 12.5 }} /></div>
              <div className="ob-field"><span className="mini-label">Contact / founder</span><input className="field" value={draft.contact_name} onChange={(e) => setDraft((x) => ({ ...x, contact_name: e.target.value }))} /></div>
              <div className="ob-field"><span className="mini-label">Industry</span><input className="field" value={draft.industry} onChange={(e) => setDraft((x) => ({ ...x, industry: e.target.value }))} /></div>
              <div className="ob-field"><span className="mini-label">Website {logoBusy ? '· fetching logo…' : ''}</span><input className="field" value={draft.website_url} onChange={(e) => setDraft((x) => ({ ...x, website_url: e.target.value }))} onBlur={(e) => { const u = normalizeUrl(e.target.value); setDraft((x) => ({ ...x, website_url: u })); grabLogo(u) }} /></div>
              <div className="ob-field"><span className="mini-label">Tagline</span><input className="field" value={draft.tagline} onChange={(e) => setDraft((x) => ({ ...x, tagline: e.target.value }))} /></div>
            </div>
            <LogoControl
              logo={draft.ref.logo_manual || draft.ref.logo_scraped}
              isManual={!!draft.ref.logo_manual}
              busy={logoBusy}
              onUpload={onUploadLogo}
              onRemove={removeManualLogo}
            />
          </motion.div>

          <motion.div className="card bb-card" style={{ gridColumn: '1 / -1' }} variants={cardV}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div><span className="eyebrow">Channels</span><h2 className="bb-h2">Social accounts</h2></div>
              <button className="btn btn-ghost btn-sm" onClick={addSocial}><Icon.Plus width={14} height={14} /> Add channel</button>
            </div>
            {draft.social_media_accounts.map((s, i) => (
              <div className="ob-rowline" key={i} style={{ marginTop: 12 }}>
                <select className="field" value={s.platform} onChange={(e) => setSocial(i, 'platform', e.target.value)}>
                  {SOCIAL_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                {platformHasHandle(s.platform) ? (
                  <>
                    <input className="field" value={s.handle} placeholder="@handle" onChange={(e) => setSocial(i, 'handle', e.target.value)} />
                    <input className="field" value={s.url} placeholder="https://…" onChange={(e) => setSocial(i, 'url', e.target.value)} onBlur={(e) => setSocial(i, 'url', normalizeUrl(e.target.value))} />
                  </>
                ) : (
                  <input className="field" style={{ gridColumn: 'span 2' }} value={s.url} placeholder="https://… (newsletter / signup URL)" onChange={(e) => setSocial(i, 'url', e.target.value)} onBlur={(e) => setSocial(i, 'url', normalizeUrl(e.target.value))} />
                )}
                <button className="ob-x" onClick={() => removeSocial(i)} aria-label="Remove channel">✕</button>
              </div>
            ))}
          </motion.div>
          </motion.div>
          )}

          {editScope === 'guideline' && (
          <motion.div key="edit-guideline" className="bb-grid" variants={panelV} initial="hidden" animate="show" exit="exit">
          <motion.div className="card bb-card" style={{ gridColumn: '1 / -1' }} variants={cardV}>
            <span className="eyebrow">Brand source</span>
            <h2 className="bb-h2">Fill it in</h2>
            <div className="seg-tabs seg-tabs-anim" style={{ margin: '14px 0 0' }}>
              <button className={`seg-tab ${brandMode === 'manual' ? 'on' : ''}`} onClick={() => setBrandMode('manual')}>
                Manual
                {brandMode === 'manual' && <motion.span layoutId="seg-underline" className="seg-underline" transition={{ type: 'spring', stiffness: 380, damping: 32 }} />}
              </button>
              <button className={`seg-tab ${brandMode === 'auto' ? 'on' : ''}`} onClick={() => { setBrandMode('auto'); setExtractUrl((u) => u || draft.website_url || client.website_url) }}>
                <Icon.Spark width={13} height={13} /> Automatic · AI
                {brandMode === 'auto' && <motion.span layoutId="seg-underline" className="seg-underline" transition={{ type: 'spring', stiffness: 380, damping: 32 }} />}
              </button>
            </div>
            {brandMode === 'auto' && (
              <div className="ob-extract" style={{ marginTop: 14 }}>
                <div className="row" style={{ gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div className="ob-field" style={{ flex: 1, minWidth: 240 }}>
                    <span className="mini-label">Website to read</span>
                    <input className="field" value={extractUrl} placeholder="https://yourwebsite.com" onChange={(e) => setExtractUrl(e.target.value)} onBlur={(e) => setExtractUrl(normalizeUrl(e.target.value))} />
                  </div>
                  <button className="btn btn-primary" onClick={runExtract} disabled={extractBusy}><Icon.Spark /> {extractBusy ? 'Reading the site…' : 'Extract with AI'}</button>
                </div>
                {extractMsg && <p className="ob-hint" style={{ margin: '12px 0 0' }}>{extractMsg}</p>}
                {extractBusy && <p className="ob-hint" style={{ margin: '8px 0 0' }}>Painting the real page in a browser for exact colors, fonts & logo, plus a voice pass - this can take 30–90s.</p>}
              </div>
            )}
            {brandMode === 'manual' && (
              <div className="ob-extract" style={{ marginTop: 14 }}>
                <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label className="btn btn-primary" style={{ cursor: extractBusy ? 'default' : 'pointer', opacity: extractBusy ? 0.6 : 1 }}>
                    <Icon.Spark /> {extractBusy ? 'Reading the PDF…' : 'Upload brand-guide PDF'}
                    <input type="file" hidden accept="application/pdf,.pdf" disabled={extractBusy} onChange={onUploadBrandPdf} />
                  </label>
                  <span className="muted-text" style={{ fontSize: 12.5 }}>AI reads the PDF and fills the fields below - or just type them in.</span>
                </div>
                {extractMsg && <p className="ob-hint" style={{ margin: '12px 0 0' }}>{extractMsg}</p>}
              </div>
            )}
          </motion.div>

          <motion.div className="card bb-card" style={{ gridColumn: '1 / -1' }} variants={cardV}>
            <span className="eyebrow">Voice & tone</span>
            <h2 className="bb-h2">How they sound</h2>
            <div className="ob-stack">
              <div className="ob-field"><span className="mini-label">Brand tone</span><textarea className="field" value={draft.ref.brand_tone} onChange={(e) => updRef({ brand_tone: e.target.value })} /></div>
              <div className="ob-field"><span className="mini-label">Mission</span><textarea className="field" value={draft.ref.mission} onChange={(e) => updRef({ mission: e.target.value })} /></div>
              <div className="ob-grid">
                <div className="ob-field"><span className="mini-label">Lean into (comma)</span><input className="field" value={draft.ref.keywords} onChange={(e) => updRef({ keywords: e.target.value })} /></div>
                <div className="ob-field"><span className="mini-label">Avoid words (comma)</span><input className="field" value={draft.ref.avoid_words} onChange={(e) => updRef({ avoid_words: e.target.value })} /></div>
              </div>
            </div>
            <div className="ob-divider" />
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span className="ob-section-title">Content pillars</span>
              <button className="btn btn-ghost btn-sm" onClick={addPillar} disabled={(draft.ref.content_pillars || []).length >= 6}><Icon.Plus width={14} height={14} /> Add pillar</button>
            </div>
            <p className="ob-hint" style={{ margin: '0 0 12px' }}>3–6 themes this brand always returns to. Ideas and posts will aim at one pillar.</p>
            {(draft.ref.content_pillars || []).map((p, i) => (
              <div className="ob-grid" key={i} style={{ marginBottom: 10, alignItems: 'start' }}>
                <div className="ob-field">
                  <span className="mini-label">Pillar name</span>
                  <input className="field" value={p.name} placeholder="e.g. Founder lessons" onChange={(e) => setPillar(i, 'name', e.target.value)} />
                </div>
                <div className="ob-field" style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
                  <div style={{ flex: 1 }}>
                    <span className="mini-label">Description</span>
                    <input className="field" value={p.description} placeholder="What stories / angles live here" onChange={(e) => setPillar(i, 'description', e.target.value)} />
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => removePillar(i)} aria-label="Remove pillar">×</button>
                </div>
              </div>
            ))}
            <div className="ob-divider" />
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span className="ob-section-title">Voices</span>
              <button className="btn btn-ghost btn-sm" onClick={addVoice}><Icon.Plus width={14} height={14} /> Add voice</button>
            </div>
            {draft.ref.voices.map((v, i) => (
              <VoiceEditor
                key={i}
                voice={v}
                busy={voiceDocBusy === i}
                onKind={(k) => setVoice(i, 'kind', k)}
                onChange={(k, val) => setVoice(i, k, val)}
                onRemove={() => removeVoice(i)}
                onUploadDoc={(e) => onUploadVoiceDoc(i, e)}
              />
            ))}
          </motion.div>

          <motion.div className="card bb-card" style={{ gridColumn: '1 / -1' }} variants={cardV}>
            <IdentityEditor value={draft.ref.identity} logo={draft.ref.logo_manual || draft.ref.logo_scraped} onChange={(next) => setDraft((x) => ({ ...x, ref: { ...x.ref, identity: next } }))} />
          </motion.div>
          </motion.div>
          )}
        </AnimatePresence>
      ) : (
        /* ===================== VIEW MODE ===================== */
        <>
          <AnimatePresence mode="wait" initial={false}>
          {tab === 'details' && (
          <motion.div key="details" className="bp-grid" variants={panelV} initial="hidden" animate="show" exit="exit">
            <motion.section className="bp-card" variants={cardV}>
              <div className="bp-head"><span className="bp-eyebrow">Identity</span><h2 className="bp-title">The basics</h2></div>
              <dl className="bp-dl">
                <div className="bp-drow"><dt>Contact</dt><dd>{client.contact_name || '-'}</dd></div>
                <div className="bp-drow"><dt>Industry</dt><dd>{client.industry || '-'}</dd></div>
                <div className="bp-drow"><dt>Website</dt><dd>{client.website_url ? <a className="bp-link" href={client.website_url} target="_blank" rel="noreferrer">{client.website_url}</a> : '-'}</dd></div>
              </dl>
            </motion.section>

            <motion.section className="bp-card" variants={cardV}>
              <div className="bp-head"><span className="bp-eyebrow">Channels</span><h2 className="bp-title">Social accounts</h2></div>
              {socials.length === 0 ? <p className="bb-empty">No channels yet.</p> : (
                <div className="bp-chans">
                  {socials.map((s, i) => (
                    <div className="bp-chan" key={i}>
                      <span className="pill">{platformName(s.platform)}</span>
                      <span className="bp-chan-handle">{s.handle || s.url || '-'}</span>
                      {s.url && <a className="bp-link" href={s.url} target="_blank" rel="noreferrer">Open ↗</a>}
                    </div>
                  ))}
                </div>
              )}
            </motion.section>
          </motion.div>
          )}

          {tab === 'guideline' && (
          <motion.div key="guideline" variants={panelV} initial="hidden" animate="show" exit="exit">
          {!hasGuideline && (
            <motion.section className="bp-card bp-full bp-guide-empty" variants={cardV}>
              <span className="bp-guide-ico"><Icon.Spark width={24} height={24} /></span>
              <h2 className="bp-title">No guideline yet</h2>
              <p>Build the Brand guideline by hand, from a brand-guide PDF, or by reading their website.</p>
              <button className="btn btn-rose" onClick={() => setChoosing(true)}><Icon.Spark width={14} height={14} /> Build Brand guideline</button>
            </motion.section>
          )}

          {hasGuideline && (ref.brand_tone || ref.mission || ref.keywords?.length || ref.avoid_words?.length || ref.content_pillars?.length || voices.length > 0) && (
            <motion.section className="bp-card bp-full" variants={cardV}>
              <div className="bp-head"><span className="bp-eyebrow">Voice & tone</span><h2 className="bp-title">How they sound</h2></div>
              {ref.brand_tone && <p className="bp-statement">{ref.brand_tone}</p>}
              {ref.mission && <p className="bp-mission">{ref.mission}</p>}
              {(ref.keywords?.length > 0 || ref.avoid_words?.length > 0) && (
                <div className="bp-tagcols">
                  {ref.keywords?.length > 0 && <div><span className="bp-eyebrow">Lean into</span><div className="row wrap" style={{ gap: 6, marginTop: 8 }}>{ref.keywords.map((t) => <span className="pill" key={t}>{t}</span>)}</div></div>}
                  {ref.avoid_words?.length > 0 && <div><span className="bp-eyebrow">Avoid</span><div className="row wrap" style={{ gap: 6, marginTop: 8 }}>{ref.avoid_words.map((t) => <span className="pill bp-pill-avoid" key={t}>{t}</span>)}</div></div>}
                </div>
              )}
              {ref.content_pillars?.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <span className="bp-eyebrow">Content pillars</span>
                  <div className="bp-voices" style={{ marginTop: 10 }}>
                    {ref.content_pillars.map((p, i) => (
                      <div className="bp-voice" key={i}>
                        <div className="bp-voice-head"><span className="bp-voice-name">{p.name}</span></div>
                        {p.description && <p className="bp-vline">{p.description}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {voices.length > 0 && (
                <div className="bp-voices">
                  {voices.map((v, i) => (
                    <div className="bp-voice" key={i}>
                      <div className="bp-voice-head"><span className="bp-voice-name">{v.name}</span><span className="pill">{v.kind} · {povName(v.pov)}</span></div>
                      {v.tone_attributes?.length > 0 && <div className="row wrap" style={{ gap: 6, margin: '4px 0 8px' }}>{v.tone_attributes.map((t) => <span className="pill" key={t}>{t}</span>)}</div>}
                      {v.dos?.length > 0 && <p className="bp-vline"><b>Do</b> {v.dos.join(', ')}</p>}
                      {v.donts?.length > 0 && <p className="bp-vline"><b>Don't</b> {v.donts.join(', ')}</p>}
                      {v.samples?.length > 0 && <div style={{ marginTop: 8 }}>{v.samples.map((s, j) => <div className="bb-sample" key={j}>{s}</div>)}</div>}
                      {v.doc?.url && <div className="ob-doc" style={{ marginTop: 8 }}><Icon.Layers width={16} height={16} /><a className="ob-doc-name" href={v.doc.url} target="_blank" rel="noreferrer">{v.doc.title}</a><span className="pill">PDF</span></div>}
                    </div>
                  ))}
                </div>
              )}
            </motion.section>
          )}

          {swatches.length > 0 && (
            <motion.section className="bp-card bp-full" variants={cardV}>
              <div className="bp-head"><span className="bp-eyebrow">Color{idn.source === 'ai' ? ' · AI-extracted' : ''}</span><h2 className="bp-title">Palette</h2></div>
              {primarySwatches.length > 0 && (
                <div className="bp-palette">
                  {primarySwatches.map((c, i) => (
                    <div className="bp-swatch" key={i}>
                      <div className="bp-swatch-fill" style={{ background: c.hex }} />
                      <div className="bp-swatch-meta">
                        <span className="bp-swatch-name">{c.name || '-'}</span>
                        {c.weight !== '' && c.weight != null && <span className="bp-swatch-weight">{c.weight}</span>}
                      </div>
                      <div className="bp-swatch-hex">{c.hex}</div>
                    </div>
                  ))}
                </div>
              )}
              {supportingSwatches.length > 0 && (
                <>
                  <span className="bp-eyebrow" style={{ display: 'block', marginTop: primarySwatches.length ? 30 : 0 }}>Supporting tones</span>
                  <div className="bp-palette bp-palette-sm" style={{ marginTop: 14 }}>
                    {supportingSwatches.map((c, i) => (
                      <div className="bp-swatch" key={i}>
                        <div className="bp-swatch-fill" style={{ background: c.hex }} />
                        <div className="bp-swatch-name">{c.name || '-'}</div>
                        <div className="bp-swatch-hex">{c.hex}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {idn.colors?.rule && <p className="bp-rule">{idn.colors.rule}</p>}
            </motion.section>
          )}

          {fontList.length > 0 && (
            <motion.section className="bp-card bp-full" variants={cardV}>
              <div className="bp-head"><span className="bp-eyebrow">Typography</span><h2 className="bp-title">Type</h2></div>
              <div className="bp-types">
                {fontList.map((f, i) => (
                  <div className="bp-type" key={i}>
                    <span className="bp-type-aa" style={{ fontFamily: `'${f.family}', Georgia, serif` }}>Aa</span>
                    <div style={{ minWidth: 0 }}>
                      <div className="bp-type-name" style={{ fontFamily: `'${f.family}', Georgia, serif` }}>{f.family}</div>
                      {f.role && <div className="bp-type-role">{f.role}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </motion.section>
          )}

          {(logoSrc || idn.positioning?.tagline || idn.positioning?.statement || idn.wordmark?.rules || wmDonts.length > 0) && (
            <motion.section className="bp-card bp-full" variants={cardV}>
              <div className="bp-head"><span className="bp-eyebrow">Positioning & wordmark</span><h2 className="bp-title">The mark</h2></div>
              {logoSrc && (
                <ClientLogo className="bp-mark-logo" src={logoSrc} alt={`${client.name} logo`} />
              )}
              {idn.positioning?.tagline && <p className="bp-statement" style={{ fontSize: '1.5rem' }}>{idn.positioning.tagline}</p>}
              {idn.positioning?.statement && <p className="bp-mission">{idn.positioning.statement}</p>}
              {(idn.wordmark?.rules || wmDonts.length > 0) && (
                <dl className="bp-dl" style={{ marginTop: 10 }}>
                  {idn.wordmark?.rules && <div className="bp-drow"><dt>Wordmark</dt><dd>{idn.wordmark.rules}</dd></div>}
                  {wmDonts.length > 0 && <div className="bp-drow"><dt>Don'ts</dt><dd>{wmDonts.join(' · ')}</dd></div>}
                </dl>
              )}
            </motion.section>
          )}

          {docs.length > 0 && (
            <motion.section className="bp-card bp-full" variants={cardV}>
              <div className="bp-head"><span className="bp-eyebrow">Reference material</span><h2 className="bp-title">Source documents</h2></div>
              <div className="bp-docs">
                {docs.map((doc, i) => (
                  <div className="ob-doc" key={i}><Icon.Layers width={16} height={16} /><a className="ob-doc-name" href={doc.url} target="_blank" rel="noreferrer">{doc.title}</a><span className="pill">PDF</span></div>
                ))}
              </div>
            </motion.section>
          )}
          </motion.div>
          )}
          </AnimatePresence>
        </>
      )}

      {extractBusy && <BrainLoading kind={extractKind} lines={extractKind === 'site' ? extractLines : undefined} />}

      {choosing && (
        <Modal wide title="Build the client guideline" sub="Two ways to fill it in - pick one, then edit anything after." onClose={() => setChoosing(false)}>
          <div className="bp-choose">
            <button className="bp-choose-card" onClick={() => beginBuild('manual')}>
              <span className="bp-choose-ico"><Icon.Layers width={20} height={20} /></span>
              <span className="bp-choose-name">Manual · PDF</span>
              <span className="bp-choose-desc">Upload a brand-guide PDF and AI reads the colors, type, voice & more.</span>
            </button>
            <button className="bp-choose-card" onClick={() => beginBuild('auto')}>
              <span className="bp-choose-ico"><Icon.Spark width={20} height={20} /></span>
              <span className="bp-choose-name">Automatic · AI</span>
              <span className="bp-choose-desc">Paste the website - AI crawls it and drafts the voice, colors, type & more.</span>
            </button>
          </div>
        </Modal>
      )}

      {buildFlow && (
        <Modal
          title={buildFlow === 'manual' ? 'Upload brand-guide PDF' : 'Read the website'}
          sub={buildFlow === 'manual'
            ? 'AI reads the PDF and drafts the full guideline - you review and edit after.'
            : 'AI crawls the site and drafts the full guideline - you review and edit after.'}
          onClose={() => { setBuildFlow(null); setErr('') }}
        >
          {buildFlow === 'manual' ? (
            <label className="bp-drop">
              <Icon.Layers width={26} height={26} />
              <span className="bp-drop-title">Click to choose a PDF</span>
              <span className="bp-drop-sub">Brand guide, deck - we read the colors, type, voice & more.</span>
              <input type="file" hidden accept="application/pdf,.pdf" onChange={onBuildPdf} />
            </label>
          ) : (
            <div className="stack">
              <div><span className="label">Website URL</span><input className="field" autoFocus value={extractUrl} placeholder="https://yourwebsite.com" onChange={(e) => setExtractUrl(e.target.value)} onBlur={(e) => setExtractUrl(normalizeUrl(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && onBuildUrl()} /></div>
              <div className="modal-actions">
                <button className="btn btn-ghost" onClick={() => { setBuildFlow(null); setErr('') }}>Cancel</button>
                <button className="btn btn-rose" onClick={onBuildUrl}><Icon.Spark /> Extract with AI</button>
              </div>
            </div>
          )}
          {err && <div className="lock-note" style={{ marginTop: 14 }}>{err}</div>}
        </Modal>
      )}
    </div>
  )
}
