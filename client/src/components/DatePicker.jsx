import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../icons.jsx'
import { iso } from '../lib/util.js'

// An on-brand replacement for <input type="date"> — the native popup can't be
// themed, so this renders a styled calendar in a portal (fixed-positioned, so
// it's never clipped by a scrolling modal, and flips above the field when
// there isn't room below). `value`/`onChange` speak YYYY-MM-DD strings.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

const parseISO = (s) => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const fmt = (s) => {
  const d = parseISO(s)
  return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
}
const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

const POP_H = 330 // approx popover height, for flip decision

export function DatePicker({ value, onChange, min, disablePast = false, placeholder = 'Pick a date', className = '', style }) {
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(() => parseISO(value) || new Date())
  const [pos, setPos] = useState(null) // { left, width, top?, bottom? }
  const triggerRef = useRef(null)
  const popRef = useRef(null)

  const place = () => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const openUp = spaceBelow < POP_H && r.top > spaceBelow
    const width = Math.max(r.width, 268)
    const left = Math.min(r.left, window.innerWidth - width - 12)
    setPos(openUp
      ? { left, width, bottom: window.innerHeight - r.top + 6 }
      : { left, width, top: r.bottom + 6 })
  }

  useLayoutEffect(() => {
    if (!open) return
    setCursor(parseISO(value) || new Date())
    place()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (!popRef.current?.contains(e.target) && !triggerRef.current?.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setOpen(false) }
    }
    const onReflow = () => place()
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true) // capture: catch scroll inside the modal too
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open])

  const y = cursor.getFullYear(), m = cursor.getMonth()
  const startPad = new Date(y, m, 1).getDay()
  const daysInMonth = new Date(y, m + 1, 0).getDate()
  const cells = []
  for (let i = 0; i < startPad; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(y, m, d))
  while (cells.length % 7 !== 0) cells.push(null)

  const selected = parseISO(value)
  const todayIso = iso(new Date())
  // Lower bound: an explicit `min`, or today when disablePast is set.
  const minD = parseISO(min) || (disablePast ? parseISO(todayIso) : null)
  const move = (delta) => setCursor(new Date(y, m + delta, 1))
  const disabled = (d) => minD && iso(d) < iso(minD)
  const pick = (d) => { if (disabled(d)) return; onChange(iso(d)); setOpen(false) }
  // Don't let the back-nav wander into fully-disabled months before the minimum.
  const canPrev = !minD || y > minD.getFullYear() || (y === minD.getFullYear() && m > minD.getMonth())

  return (
    <div className={`dp ${className}`.trim()} style={style}>
      <button type="button" ref={triggerRef} className={`field dp-trigger ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)}>
        <Icon.Calendar width={15} height={15} />
        <span className={value ? '' : 'dp-ph'}>{value ? fmt(value) : placeholder}</span>
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          className="dp-pop"
          style={{ position: 'fixed', left: pos.left, width: pos.width, ...(pos.top != null ? { top: pos.top } : { bottom: pos.bottom }) }}
        >
          <div className="dp-head">
            <button type="button" className="dp-nav" onClick={() => move(-1)} disabled={!canPrev} aria-label="Previous month">‹</button>
            <span className="dp-title">{MONTHS[m]} {y}</span>
            <button type="button" className="dp-nav" onClick={() => move(1)} aria-label="Next month">›</button>
          </div>
          <div className="dp-dow">{DOW.map((d, i) => <span key={i}>{d}</span>)}</div>
          <div className="dp-grid">
            {cells.map((d, i) => d
              ? (
                <button
                  type="button"
                  key={i}
                  className={`dp-day ${sameDay(d, selected) ? 'sel' : ''} ${iso(d) === todayIso ? 'today' : ''}`}
                  disabled={disabled(d)}
                  onClick={() => pick(d)}
                >{d.getDate()}</button>
              )
              : <span key={i} className="dp-empty" />)}
          </div>
          <div className="dp-foot">
            <button type="button" className="dp-link" onClick={() => pick(new Date())}>Today</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
