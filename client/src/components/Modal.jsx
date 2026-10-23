import { useEffect } from 'react'
import { createPortal } from 'react-dom'

export function Modal({ title, sub, children, onClose, wide, className = '' }) {
  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [])

  return createPortal(
    <div className="scrim">
      <div className={`modal ${wide ? 'modal-wide' : ''} ${className}`.trim()} role="dialog" aria-modal="true">
        <button className="modal-x" onClick={onClose} aria-label="Close">✕</button>
        {title && <h3>{title}</h3>}
        {sub && <p className="sub">{sub}</p>}
        {children}
      </div>
    </div>,
    document.body,
  )
}
