import { Icon } from '../icons.jsx'
import { ClientLogo } from './ClientLogo.jsx'
import { useGoogleFonts } from '../lib/util.js'

// Editable brand identity - the full brand-guide spec (positioning, voice
// principles, color, type, wordmark, marks). All fields optional; populated by
// AI extraction or by hand. `logo` is the effective mark (manual || scraped),
// shown read-only beside the wordmark rules so the mark is visible while editing.
export function IdentityEditor({ value, onChange, logo }) {
  const id = value || {}
  const pos = id.positioning || {}
  const colors = id.colors || {}
  const primary = colors.primary || []
  const supporting = colors.supporting || []
  const typo = id.typography || {}
  // fonts list (back-compat: migrate an old serif/sans/mono object to a list)
  const fonts =
    Array.isArray(typo.fonts) && typo.fonts.length
      ? typo.fonts
      : ['serif', 'sans', 'mono'].map((k) => typo[k]).filter((f) => f && (f.family || f.role)).map((f) => ({ family: f.family || '', role: f.role || '' }))
  const wm = id.wordmark || {}
  const safeHex = (h) => (/^#[0-9a-fA-F]{6}$/.test(h || '') ? h : '#000000')
  // load each typed font family so the family input renders in its real face
  useGoogleFonts(fonts.map((f) => f.family))

  const set = (patch) => onChange({ ...id, ...patch })
  const setColors = (patch) => set({ colors: { ...colors, ...patch } })
  const setPrim = (i, k, v) => setColors({ primary: primary.map((c, j) => (j === i ? { ...c, [k]: v } : c)) })
  const addPrim = () => setColors({ primary: [...primary, { name: '', hex: '#000000' }] })
  const rmPrim = (i) => setColors({ primary: primary.filter((_, j) => j !== i) })
  const setSupp = (i, k, v) => setColors({ supporting: supporting.map((c, j) => (j === i ? { ...c, [k]: v } : c)) })
  const addSupp = () => setColors({ supporting: [...supporting, { name: '', hex: '#000000' }] })
  const rmSupp = (i) => setColors({ supporting: supporting.filter((_, j) => j !== i) })
  const setFonts = (next) => set({ typography: { fonts: next } })
  const setFont = (i, k, v) => setFonts(fonts.map((f, j) => (j === i ? { ...f, [k]: v } : f)))
  const addFont = () => setFonts([...fonts, { family: '', role: '' }])
  const rmFont = (i) => setFonts(fonts.filter((_, j) => j !== i))
  const setWm = (k, v) => set({ wordmark: { ...wm, [k]: v } })
  const dontsStr = Array.isArray(wm.donts) ? wm.donts.join('\n') : wm.donts || ''

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="ob-section-title">Brand identity</span>
        {id.source === 'ai' && <span className="pill">AI · {id.source_url || 'website'}</span>}
      </div>
      <p className="ob-hint">Positioning, voice, color, type, wordmark & marks - straight from the brand guide. Edit anything.</p>

      <div className="ob-stack">
        {/* Positioning */}
        <div className="ob-field"><span className="mini-label">Positioning · tagline</span><input className="field" value={pos.tagline || ''} placeholder="Quiet intelligence, deliberately built." onChange={(e) => set({ positioning: { ...pos, tagline: e.target.value } })} /></div>
        <div className="ob-field"><span className="mini-label">What they do · statement</span><textarea className="field" value={pos.statement || ''} placeholder="A one-paragraph description of what the brand does." onChange={(e) => set({ positioning: { ...pos, statement: e.target.value } })} /></div>

        {/* Colors */}
        <div>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="mini-label" style={{ marginBottom: 0 }}>Primary colors · name & hex</span>
            <button className="btn btn-ghost btn-sm" onClick={addPrim}><Icon.Plus width={13} height={13} /> Add</button>
          </div>
          {primary.map((c, i) => (
            <div className="id-color-row" key={i} style={{ gridTemplateColumns: '44px 130px 1fr auto' }}>
              <input className="id-swatch" type="color" value={safeHex(c.hex)} onChange={(e) => setPrim(i, 'hex', e.target.value)} />
              <input className="field" value={c.hex || ''} placeholder="#000000" onChange={(e) => setPrim(i, 'hex', e.target.value)} />
              <input className="field" value={c.name || ''} placeholder="Ink" onChange={(e) => setPrim(i, 'name', e.target.value)} />
              <button className="ob-x" onClick={() => rmPrim(i)} aria-label="Remove color">✕</button>
            </div>
          ))}
        </div>
        <div>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="mini-label" style={{ marginBottom: 0 }}>Supporting tones</span>
            <button className="btn btn-ghost btn-sm" onClick={addSupp}><Icon.Plus width={13} height={13} /> Add</button>
          </div>
          {supporting.map((c, i) => (
            <div className="id-color-row" key={i} style={{ gridTemplateColumns: '44px 130px 1fr auto' }}>
              <input className="id-swatch" type="color" value={safeHex(c.hex)} onChange={(e) => setSupp(i, 'hex', e.target.value)} />
              <input className="field" value={c.hex || ''} placeholder="#000000" onChange={(e) => setSupp(i, 'hex', e.target.value)} />
              <input className="field" value={c.name || ''} placeholder="Surface" onChange={(e) => setSupp(i, 'name', e.target.value)} />
              <button className="ob-x" onClick={() => rmSupp(i)} aria-label="Remove color">✕</button>
            </div>
          ))}
        </div>
        <div className="ob-field"><span className="mini-label">Color rule</span><input className="field" value={colors.rule || ''} placeholder="Pink is punctuation, not paragraph." onChange={(e) => setColors({ rule: e.target.value })} /></div>

        {/* Typography - add as many fonts as needed */}
        <div>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="mini-label" style={{ marginBottom: 0 }}>Typography · font family + role</span>
            <button className="btn btn-ghost btn-sm" onClick={addFont}><Icon.Plus width={13} height={13} /> Add</button>
          </div>
          {fonts.map((f, i) => (
            <div className="ob-rowline" key={i} style={{ gridTemplateColumns: '1fr 1fr auto', marginTop: 8 }}>
              <input className="field" value={f.family || ''} placeholder="Cormorant Garamond" style={{ fontFamily: f.family ? `'${f.family}', var(--sans)` : undefined, fontSize: '1.05rem' }} onChange={(e) => setFont(i, 'family', e.target.value)} />
              <input className="field" value={f.role || ''} placeholder="Display & editorial" onChange={(e) => setFont(i, 'role', e.target.value)} />
              <button className="ob-x" onClick={() => rmFont(i)} aria-label="Remove font">✕</button>
            </div>
          ))}
        </div>

        {/* Wordmark - show the actual mark (read-only) next to its rules */}
        <div className="ob-field">
          <span className="mini-label">Wordmark / mark</span>
          {logo ? (
            <ClientLogo className="bp-mark-logo" src={logo} alt="wordmark" surface="light" />
          ) : (
            <p className="ob-hint" style={{ margin: '4px 0 0' }}>No mark yet - add a logo on the Client details tab.</p>
          )}
        </div>
        <div className="ob-field"><span className="mini-label">Wordmark rules</span><input className="field" value={wm.rules || ''} placeholder="Italic serif for the name, mono caps for the suffix; the slash is the hinge." onChange={(e) => setWm('rules', e.target.value)} /></div>
        <div className="ob-field"><span className="mini-label">Wordmark don'ts (one per line)</span><textarea className="field" value={dontsStr} placeholder={"Don't outline the wordmark\nDon't tilt it"} onChange={(e) => setWm('donts', e.target.value.split('\n'))} /></div>
      </div>
    </div>
  )
}
