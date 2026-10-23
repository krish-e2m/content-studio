import { Icon } from '../icons.jsx'
import { VOICE_KINDS, VOICE_POVS } from '../data.js'

// One editable voice. Custom voices are defined by an uploaded PDF; brand /
// founder voices use the manual tone / do / don't / samples inputs.
export function VoiceEditor({ voice: v, busy, onKind, onChange, onRemove, onUploadDoc }) {
  const isCustom = v.kind === 'custom'
  return (
    <div className="ob-sub" style={{ marginTop: 12 }}>
      <div className="ob-sub-head">
        <div className="chip-row">
          {VOICE_KINDS.map((k) => <button key={k.id} className={`chip ${v.kind === k.id ? 'on' : ''}`} onClick={() => onKind(k.id)}>{k.name}</button>)}
        </div>
        <button className="link-btn" onClick={onRemove}>Remove</button>
      </div>
      {isCustom ? (
        <div className="ob-grid">
          <div className="ob-field full"><span className="mini-label">Voice name</span><input className="field" value={v.name} placeholder="e.g. Campaign voice" onChange={(e) => onChange('name', e.target.value)} /></div>
          <div className="ob-field full">
            <span className="mini-label">Reference document (PDF) - defines this voice</span>
            {v.doc?.url ? (
              <div className="ob-doc">
                <Icon.Layers width={16} height={16} />
                <a className="ob-doc-name" href={v.doc.url} target="_blank" rel="noreferrer">{v.doc.title}</a>
                <button className="ob-x" onClick={() => onChange('doc', null)} aria-label="Remove document">✕</button>
              </div>
            ) : (
              <label className="btn btn-ghost btn-sm" style={{ cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1, alignSelf: 'flex-start' }}>
                <Icon.Plus width={14} height={14} /> {busy ? 'Uploading…' : 'Upload PDF'}
                <input type="file" hidden accept="application/pdf,.pdf" disabled={busy} onChange={onUploadDoc} />
              </label>
            )}
          </div>
        </div>
      ) : (
        <div className="ob-grid">
          <div className="ob-field"><span className="mini-label">Voice name</span><input className="field" value={v.name} placeholder="Brand Voice" onChange={(e) => onChange('name', e.target.value)} /></div>
          <div className="ob-field"><span className="mini-label">Point of view</span>
            <select className="field" value={v.pov} onChange={(e) => onChange('pov', e.target.value)}>{VOICE_POVS.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          </div>
          <div className="ob-field"><span className="mini-label">Tone attributes (comma)</span><input className="field" value={v.tone} placeholder="warm, clear, premium" onChange={(e) => onChange('tone', e.target.value)} /></div>
          <div className="ob-field"><span className="mini-label">Do (comma)</span><input className="field" value={v.dos} placeholder="use real examples" onChange={(e) => onChange('dos', e.target.value)} /></div>
          <div className="ob-field full"><span className="mini-label">Don't (comma)</span><input className="field" value={v.donts} placeholder="no jargon, no hype" onChange={(e) => onChange('donts', e.target.value)} /></div>
          <div className="ob-field full"><span className="mini-label">Sample posts - few-shot (separate each with a blank line)</span><textarea className="field" style={{ minHeight: 120 }} value={v.samples} placeholder={"Paste 2–3 real posts in this voice…\n\n(blank line between each)"} onChange={(e) => onChange('samples', e.target.value)} /></div>
        </div>
      )}
    </div>
  )
}
