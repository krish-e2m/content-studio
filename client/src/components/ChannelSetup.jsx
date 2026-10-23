import { useMemo, useState } from 'react'
import { Icon } from '../icons.jsx'
import { useClients } from '../context/ClientsContext.jsx'
import { updateClient } from '../api.js'
import { PLATFORM_COLORS, PLATFORM_LABELS, PLATFORM_ORDER } from '../performanceLive.js'

// Lets the account name for each channel be set from Performance itself,
// rather than sending people to Profile and back. Writes to the same
// clients.social_media_accounts field the Profile page edits, so the two
// stay in sync — this is a second door onto one setting, not a second copy.

const PLACEHOLDERS = new Set([
  'na', 'n/a', 'n.a', 'none', 'null', 'nil', 'tbd', 'tba', '-', '--', '.',
  'x', 'xx', 'xxx', 'test', 'todo', 'pending', 'nan', 'undefined',
  'tiktok.com', 'www.tiktok.com',
])

const HINTS = {
  instagram: { prefix: 'instagram.com/', example: 'fernwehcoffee' },
  linkedin:  { prefix: 'linkedin.com/company/', example: 'fernweh-coffee' },
  x:         { prefix: 'x.com/', example: 'fernwehcoffee' },
  // A publication is its host, so the whole domain is the identifier here —
  // not a path segment like every other platform.
  substack:  { prefix: '', example: 'fernweh.substack.com' },
  tiktok:    { prefix: 'tiktok.com/@', example: 'fernwehcoffee' },
}

// Mirrors server-side bareHandle so the UI can warn before a run is spent.
export function normalizeHandle(input) {
  let s = String(input || '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s) || s.includes('/')) {
    const path = s.replace(/^https?:\/\//i, '').split('?')[0]
    const parts = path.split('/').filter(Boolean)
    // Drop the domain and any /company//in/ style segment.
    const rest = parts.slice(1).filter((p) => !['company', 'in', 'pages', 'people', 'video', 'photo'].includes(p.toLowerCase()) && !/^\d+$/.test(p))
    s = rest[0] || (parts.length === 1 ? '' : parts[parts.length - 1]) || ''
  }
  return s.replace(/^@/, '').replace(/\/$/, '').trim()
}

function validate(raw) {
  const h = normalizeHandle(raw)
  if (!raw?.trim()) return { state: 'empty', handle: '' }
  if (!h) return { state: 'invalid', handle: '', why: 'That looks like a bare link with no account name in it.' }
  if (PLACEHOLDERS.has(h.toLowerCase())) return { state: 'invalid', handle: '', why: `“${h}” is a placeholder, not an account name.` }
  if (h.length < 2) return { state: 'invalid', handle: '', why: 'Too short to be an account name.' }
  return { state: 'ok', handle: h }
}

export function ChannelSetup({ client, onSaved, onClose }) {
  const { setClients } = useClients()

  // Seed each supported platform from whatever the client already has.
  // Placeholder values left over from onboarding ("NA", "TBD") are seeded as
  // empty — otherwise the field pre-fills with junk and anything typed lands
  // after it, producing handles like "NAfernwehcoffee".
  const initial = useMemo(() => {
    const existing = Array.isArray(client.social_media_accounts) ? client.social_media_accounts : []
    const usable = (v) => {
      const h = normalizeHandle(v)
      if (!h || h.length < 2) return ''
      return PLACEHOLDERS.has(h.toLowerCase()) ? '' : h
    }
    const out = {}
    PLATFORM_ORDER.forEach((p) => {
      const row = existing.find((s) => String(s?.platform || '').toLowerCase() === p)
      out[p] = usable(row?.handle) || usable(row?.url) || ''
    })
    return out
  }, [client])

  const [values, setValues] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const checks = Object.fromEntries(PLATFORM_ORDER.map((p) => [p, validate(values[p])]))
  const readyCount = PLATFORM_ORDER.filter((p) => checks[p].state === 'ok').length
  const anyInvalid = PLATFORM_ORDER.some((p) => checks[p].state === 'invalid')
  const dirty = PLATFORM_ORDER.some((p) => (values[p] || '') !== (initial[p] || ''))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      // Preserve channels we don't manage here (e.g. Substack) untouched.
      const existing = Array.isArray(client.social_media_accounts) ? client.social_media_accounts : []
      const kept = existing.filter((s) => !PLATFORM_ORDER.includes(String(s?.platform || '').toLowerCase()))

      const managed = PLATFORM_ORDER
        .filter((p) => checks[p].state === 'ok')
        .map((p) => ({
          platform: p,
          handle: checks[p].handle,
          url: `https://${HINTS[p].prefix}${checks[p].handle}`,
        }))

      const updated = await updateClient(client.id, { social_media_accounts: [...kept, ...managed] })
      setClients((arr) => (arr || []).map((c) => (c.id === updated.id ? updated : c)))
      onSaved?.(managed.length)
    } catch (err) {
      setError(err.message || 'Could not save channels.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card perf-setup">
      <div className="perf-setup-head">
        <div>
          <span className="eyebrow">Channels</span>
          <h2 className="perf-setup-title">Account names</h2>
          <p className="perf-setup-lede">
            Enter the account name as it appears in the profile URL — not the display name.
            These are the accounts scraped when you refresh.
          </p>
        </div>
        {onClose && (
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Done</button>
        )}
      </div>

      <div className="perf-setup-rows">
        {PLATFORM_ORDER.map((p) => {
          const check = checks[p]
          return (
            <div className="perf-setup-row" key={p}>
              <label className="perf-setup-label" htmlFor={`ch-${p}`}>
                <span className="perf-setup-dot" style={{ background: PLATFORM_COLORS[p] }} />
                {PLATFORM_LABELS[p]}
              </label>
              <div className={`perf-setup-input ${check.state === 'invalid' ? 'bad' : ''} ${check.state === 'ok' ? 'good' : ''}`}>
                <span className="perf-setup-prefix">{HINTS[p].prefix}</span>
                <input
                  id={`ch-${p}`}
                  className="perf-setup-field"
                  value={values[p]}
                  placeholder={HINTS[p].example}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setValues((v) => ({ ...v, [p]: e.target.value }))}
                  onBlur={(e) => setValues((v) => ({ ...v, [p]: normalizeHandle(e.target.value) }))}
                />
                {check.state === 'ok' && <span className="perf-setup-ok" aria-label="Valid">✓</span>}
              </div>
              <span className="perf-setup-note">
                {check.state === 'invalid'
                  ? <span className="perf-setup-why">{check.why}</span>
                  : check.state === 'ok'
                    ? <span className="perf-setup-muted">will scrape @{check.handle}</span>
                    : <span className="perf-setup-muted">leave blank to skip</span>}
              </span>
            </div>
          )
        })}
      </div>

      {error && <p className="perf-setup-error">{error}</p>}

      <div className="perf-setup-foot">
        <span className="perf-setup-muted">
          {readyCount} channel{readyCount === 1 ? '' : 's'} ready
          {anyInvalid && ' · fix the flagged entries to include them'}
        </span>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save channels'}
        </button>
      </div>
    </div>
  )
}
