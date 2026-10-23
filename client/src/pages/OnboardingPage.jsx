import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../icons.jsx'
import { ChromeShell } from '../components/ChromeShell.jsx'
import { StepShell } from '../components/StepShell.jsx'
import { KV } from '../components/KV.jsx'
import { LogoControl } from '../components/LogoControl.jsx'
import { useClients } from '../context/ClientsContext.jsx'
import { blankClientDraft, slugify, SOCIAL_OPTIONS, platformHasHandle } from '../data.js'
import { createClient, fetchLogo, uploadLogo } from '../api.js'
import { decorateClient, draftToClient } from '../lib/clientModel.js'
import { normalizeUrl } from '../lib/util.js'

const OB_STEPS = [
  { lead: '01', label: 'Basics' },
  { lead: '02', label: 'Channels' },
  { lead: '03', label: 'Review' },
]

export default function OnboardingPage() {
  const { setClients } = useClients()
  const navigate = useNavigate()

  // POST to the API → returns the real DB row (id, created_at, …). Throws on
  // failure so the wizard can surface the error.
  const create = async (draft) => {
    const saved = await createClient(draftToClient(draft))
    const client = decorateClient(saved)
    setClients((arr) => [...(arr || []), client])
    navigate(`/clients/${client.id}/brain`)
  }

  return (
    <ChromeShell crumb="Clients · Onboarding">
      <OnboardingWizard onCancel={() => navigate('/')} onCreate={create} />
    </ChromeShell>
  )
}

function OnboardingWizard({ onCancel, onCreate }) {
  const [d, setD] = useState(blankClientDraft)
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)
  const [logoBusy, setLogoBusy] = useState(false)
  const [err, setErr] = useState('')

  const setRef = (patch) => setD((x) => ({ ...x, ref: { ...x.ref, ...patch } }))
  const setName = (name) => setD((x) => ({ ...x, name }))
  // On website blur: scrape the site's logo (the fallback source).
  const grabLogo = async (url) => {
    const v = (url || '').trim()
    if (!v) return
    setLogoBusy(true)
    try {
      const { url: logoUrl } = await fetchLogo(v, d.ref.logo_scraped)
      if (logoUrl) setRef({ logo_scraped: logoUrl })
    } catch {
      /* logo is optional - ignore failures */
    } finally {
      setLogoBusy(false)
    }
  }
  // Manual logo upload - overrides the scraped one.
  const onUploadLogo = async (e) => {
    const file = (e.target.files || [])[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { setErr('Logo must be an image file.'); return }
    setLogoBusy(true); setErr('')
    try {
      const { url } = await uploadLogo(file, slugify(d.name) || 'unfiled')
      if (url) setRef({ logo_manual: url })
    } catch (er) { setErr(er.message || 'Logo upload failed') } finally { setLogoBusy(false) }
  }
  const removeManualLogo = () => setRef({ logo_manual: '' })

  const setSocial = (i, key, val) => setD((x) => ({ ...x, social_media_accounts: x.social_media_accounts.map((s, j) => (j === i ? { ...s, [key]: val } : s)) }))
  const addSocial = () => setD((x) => ({ ...x, social_media_accounts: [...x.social_media_accounts, { platform: 'instagram', handle: '', url: '' }] }))
  const removeSocial = (i) => setD((x) => ({ ...x, social_media_accounts: x.social_media_accounts.filter((_, j) => j !== i) }))

  const v0 = d.name.trim().length > 0
  const v1 = d.social_media_accounts.some((s) => s.platform && (s.handle.trim() || s.url.trim()))
  const canNext = (s) => (s === 0 ? v0 : s === 1 ? v1 : true)
  const canCreate = v0 && v1
  const next = () => canNext(step) && setStep((s) => Math.min(OB_STEPS.length - 1, s + 1))
  const back = () => setStep((s) => Math.max(0, s - 1))
  const row = draftToClient(d)

  const submit = async () => {
    if (!canCreate || saving) return
    setSaving(true)
    setErr('')
    try {
      await onCreate(d) // navigates away on success
    } catch (e) {
      setErr(e.message || 'Failed to save')
      setSaving(false)
    }
  }

  return (
    <div className="view">
      <div className="page-head" style={{ marginBottom: 18 }}>
        <span className="eyebrow">Clients · Onboarding</span>
        <h1>Add a client</h1>
      </div>

      <div className="stepper">
        {OB_STEPS.map((s, i) => {
          const state = i < step ? 'done' : i === step ? 'now' : 'todo'
          const reachable = i <= step
          return (
            <button key={s.lead} className={`stepper-item ${state}`} disabled={!reachable} onClick={() => reachable && setStep(i)}>
              <span className="stepper-dot">{i < step ? <Icon.Check width={13} height={13} /> : s.lead}</span>
              <span className="stepper-label">{s.label}</span>
            </button>
          )
        })}
      </div>

      <div className="card wizard">
        {/* Step 01 - Basics */}
        {step === 0 && (
          <StepShell n="01" title="Who's the client?" hint="The essentials. The slug is the URL handle and is filled in for you.">
            <div className="ob-grid">
              <div className="ob-field"><span className="mini-label">Client / brand name *</span><input className="field" autoFocus value={d.name} placeholder="e.g. Your Brand Name" onChange={(e) => setName(e.target.value)} /></div>
              <div className="ob-field"><span className="mini-label">Contact / founder</span><input className="field" value={d.contact_name} placeholder="Founder / Contact" onChange={(e) => setD((x) => ({ ...x, contact_name: e.target.value }))} /></div>
              <div className="ob-field"><span className="mini-label">Industry</span><input className="field" value={d.industry} placeholder="e.g. Digital Marketing" onChange={(e) => setD((x) => ({ ...x, industry: e.target.value }))} /></div>
              <div className="ob-field"><span className="mini-label">Website {logoBusy ? '· fetching logo…' : ''}</span><input className="field" value={d.website_url} placeholder="https://yourwebsite.com" onChange={(e) => setD((x) => ({ ...x, website_url: e.target.value }))} onBlur={(e) => { const u = normalizeUrl(e.target.value); setD((x) => ({ ...x, website_url: u })); grabLogo(u) }} /></div>
              <div className="ob-field full"><span className="mini-label">Tagline</span><input className="field" value={d.tagline} placeholder="Founder-led · Brand Marketing" onChange={(e) => setD((x) => ({ ...x, tagline: e.target.value }))} /></div>
            </div>

            <LogoControl
              logo={d.ref.logo_manual || d.ref.logo_scraped}
              isManual={!!d.ref.logo_manual}
              busy={logoBusy}
              onUpload={onUploadLogo}
              onRemove={removeManualLogo}
            />
            <p className="ob-hint" style={{ marginTop: 14, marginBottom: 0 }}>A unique ID is generated automatically on save - there's no slug to manage.</p>
          </StepShell>
        )}

        {/* Step 02 - Channels */}
        {step === 1 && (
          <StepShell n="02" title="Connect their channels" hint="Where this client publishes - this is the social_media_accounts JSON. At least one is required.">
            {!v1 && <div className="lock-note">Add at least one channel to continue.</div>}
            {d.social_media_accounts.map((s, i) => (
              <div className="ob-rowline" key={i}>
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
                <button className="ob-x" onClick={() => removeSocial(i)} disabled={d.social_media_accounts.length === 1} aria-label="Remove channel">✕</button>
              </div>
            ))}
            <button className="btn btn-ghost btn-sm ob-add" onClick={addSocial}><Icon.Plus width={14} height={14} /> Add channel</button>
          </StepShell>
        )}

        {/* Step 03 - Review */}
        {step === 2 && (
          <StepShell n="03" title="Review & create" hint="A quick summary before this client is created. You'll build the Brand Brain from their profile.">
            <div className="ob-review-grid">
              <KV k="Name" v={row.name} />
              <KV k="Contact" v={row.contact_name} />
              <KV k="Industry" v={row.industry} />
              <KV k="Website" v={row.website_url} />
              <KV k="Tagline" v={row.tagline} />
              <KV k="Channels" v={`${row.social_media_accounts.length} connected`} />
            </div>
            <p className="ob-hint" style={{ marginTop: 18 }}>After creating, open the client's <strong>Brand Brain</strong> to add voice, colors, type and reference docs - by hand, from a PDF, or auto-extracted from the website.</p>
          </StepShell>
        )}

        {err && <div className="lock-note" style={{ margin: '0 30px 16px' }}>{err}</div>}
        <div className="wizard-foot">
          <button className="btn btn-ghost" onClick={step === 0 ? onCancel : back} disabled={saving}>{step === 0 ? 'Cancel' : <><Icon.Back /> Back</>}</button>
          <span className="step-count">Step {step + 1} of {OB_STEPS.length} · {OB_STEPS[step].label}</span>
          {step < OB_STEPS.length - 1 ? (
            <button className="btn btn-primary" onClick={next} disabled={!canNext(step)}>Next <Icon.Arrow className="arrow" /></button>
          ) : (
            <button className="btn btn-rose" onClick={submit} disabled={!canCreate || saving}>{saving ? 'Saving…' : 'Create client'} <Icon.Arrow className="arrow" /></button>
          )}
        </div>
      </div>
    </div>
  )
}
