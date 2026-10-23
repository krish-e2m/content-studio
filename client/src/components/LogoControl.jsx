import { Icon } from '../icons.jsx'

// Logo block: shows the effective logo (manual ?? scraped) + upload / revert.
export function LogoControl({ logo, isManual, busy, onUpload, onRemove }) {
  return (
    <div className="ob-logo-ctl">
      <span className="ob-logo-box">
        {logo ? <img className="avatar-img" src={logo} alt="logo" /> : <Icon.Image width={20} height={20} />}
      </span>
      <div style={{ minWidth: 0 }}>
        <span className="mini-label">Logo {busy ? '· working…' : isManual ? '· manual upload' : logo ? '· from website' : ''}</span>
        <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          <label className="btn btn-ghost btn-sm" style={{ cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
            <Icon.Plus width={14} height={14} /> Upload logo
            <input type="file" hidden accept="image/*" disabled={busy} onChange={onUpload} />
          </label>
          {isManual && <button className="link-btn" onClick={onRemove}>Remove · use website logo</button>}
        </div>
        <p className="ob-hint" style={{ margin: '8px 0 0' }}>Auto-fetched from the website. Upload to override; remove to revert.</p>
      </div>
    </div>
  )
}
