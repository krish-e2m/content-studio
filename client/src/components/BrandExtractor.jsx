// =========================================================================
// BrandExtractor - harness for the branding extractor engine.
// URL input + Extract button + live progress log + a preview of the result
// (logo, palette, screenshots) and the raw branding.json.
//
// Styled with the workspace design system (cards, fields, pills, buttons) so
// it matches every other section instead of carrying its own inline styles.
// =========================================================================
import { useState } from 'react'
import { Icon } from '../icons.jsx'
import { useExtraction } from '../hooks/useExtraction.js'

export default function BrandExtractor() {
  const [url, setUrl] = useState('https://stripe.com')
  const { start, reset, status, progressLines, result, error, fileUrl } = useExtraction()
  const running = status === 'running'

  const onSubmit = (e) => { e.preventDefault(); if (url.trim()) start(url.trim()) }

  return (
    <div className="view">
      <div className="page-head">
        <span className="eyebrow">Brand extractor</span>
        <h1>Reverse-engineer a site's brand</h1>
        <p className="lede">Drives a headless browser to a site and reads back its visual brand - logo, palette, type and screenshots.</p>
      </div>

      <div className="card card-pad bx-form-card">
        <form onSubmit={onSubmit} className="bx-form">
          <input
            className="field"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            disabled={running}
            aria-label="Site URL"
          />
          <button className="btn btn-primary" type="submit" disabled={running}>
            <Icon.Spark width={14} height={14} /> {running ? 'Extracting…' : 'Extract'}
          </button>
          {(status === 'done' || status === 'error') && (
            <button className="btn btn-ghost" type="button" onClick={reset}>Reset</button>
          )}
        </form>

        <div className="bx-status">
          <span className={`pill ${running ? 'rose' : ''}`}>
            {running && <span className="suggest-spinner bx-spinner" />}
            {status}
          </span>
          {error && <span className="bx-error"><Icon.Spark width={13} height={13} /> {error}</span>}
        </div>
      </div>

      {/* live progress log */}
      {(running || progressLines.length > 0) && (
        <div className="card card-pad">
          <span className="mini-label">Progress</span>
          <ul className="bx-log">
            {progressLines.map((line, i) => (
              <li key={i} className={line.startsWith('!') ? 'warn' : ''}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {/* result preview */}
      {result && (
        <>
          <div className="card card-pad">
            <span className="mini-label">Brand</span>
            <div className="bx-brand">
              {result.logo && (
                <span className="bx-logo"><img src={fileUrl(result.logo.file)} alt="Extracted logo" /></span>
              )}
              <div className="bx-swatches">
                {(result.colors?.all || []).slice(0, 8).map((hex) => (
                  <span key={hex} className="bx-swatch" title={hex} style={{ background: hex }} />
                ))}
              </div>
            </div>
            <dl className="bp-dl bx-dl">
              <div className="bp-drow"><dt>Primary</dt><dd>{result.colors?.primary || '—'}</dd></div>
              <div className="bp-drow"><dt>Background</dt><dd>{result.colors?.background || '—'}</dd></div>
              <div className="bp-drow"><dt>Text</dt><dd>{result.colors?.text || '—'}</dd></div>
              <div className="bp-drow"><dt>Fonts</dt><dd>{(result.typography?.fonts_used || []).join(', ') || '—'}</dd></div>
              <div className="bp-drow"><dt>QA score</dt><dd>{result.qa?.score ?? '—'}/100</dd></div>
            </dl>
          </div>

          {result.screenshots?.desktop?.length > 0 && (
            <div className="card card-pad">
              <span className="mini-label">Screenshots</span>
              <div className="bx-shots">
                {result.screenshots.desktop.map((s) => (
                  <img key={s} src={fileUrl(s)} alt={s} />
                ))}
              </div>
            </div>
          )}

          <details className="card card-pad bx-raw">
            <summary><span className="mini-label">Raw branding.json</span></summary>
            <pre>{JSON.stringify(result, null, 2)}</pre>
          </details>
        </>
      )}
    </div>
  )
}
