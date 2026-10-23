import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../icons.jsx'

// Full-screen loader shown while AI reads a website / PDF.
// If `lines` (live progress messages) are passed, it shows the real feed;
// otherwise it falls back to a canned looping sequence.
export function BrainLoading({ kind, lines }) {
  const live = Array.isArray(lines) && lines.length > 0
  const steps =
    kind === 'pdf'
      ? ['Reading the PDF…', 'Pulling colors & type…', 'Analysing voice & tone…', 'Structuring the guideline…']
      : ['Crawling the website…', 'Collecting colors & fonts…', 'Reading the copy…', 'Analysing voice & tone…', 'Structuring the guideline…']
  const [i, setI] = useState(0)
  useEffect(() => {
    if (live) return
    const t = setInterval(() => setI((x) => (x + 1) % steps.length), 1500)
    return () => clearInterval(t)
  }, [steps.length, live])

  // keep the feed scrolled to the newest line
  const feedRef = useRef(null)
  useEffect(() => { if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight }, [lines])

  const current = live ? lines[lines.length - 1].replace(/^!\s*/, '') : steps[i]

  return createPortal(
    <div className="bl-scrim">
      <div className="bl-card">
        <div className="bl-orb">
          <span className="bl-ring" />
          <span className="bl-ring bl-ring2" />
          <Icon.Spark width={28} height={28} />
        </div>
        <div className="bl-title">Reading the brand</div>
        <div className="bl-step" key={current}>{current}</div>
        <div className="bl-bar"><span /></div>
        {live && (
          <div
            ref={feedRef}
            style={{
              marginTop: 16, maxHeight: 132, width: '100%', overflowY: 'auto',
              fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: 11.5,
              lineHeight: 1.6, textAlign: 'left', opacity: 0.7,
            }}
          >
            {lines.slice(-12).map((l, k, arr) => (
              <div
                key={`${k}-${l}`}
                style={{ color: l.startsWith('!') ? '#b36b00' : 'inherit', opacity: k === arr.length - 1 ? 1 : 0.55 }}
              >
                {l.startsWith('!') ? '⚠ ' : '· '}{l.replace(/^!\s*/, '')}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
