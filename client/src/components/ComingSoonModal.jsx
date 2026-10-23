import { Icon } from '../icons.jsx'
import { Modal } from './Modal.jsx'

// A small gated-feature dialog. The backend for these features is built and left
// intact - we just switch them off for now and show a polished "coming soon"
// note in place of running them. Reused by the Photo Library and the Composer.
export function ComingSoonModal({ title = 'Coming soon', text, onClose }) {
  return (
    <Modal title="" onClose={onClose} className="modal-soon">
      <div className="soon-hero">
        <span className="soon-glyph"><Icon.Spark width={24} height={24} /></span>
        <span className="soon-badge">Coming soon</span>
        <h3 className="soon-title">{title}</h3>
        {text && <p className="soon-text">{text}</p>}
      </div>
      <div className="modal-actions soon-actions">
        <button className="btn btn-rose" onClick={onClose}>Got it</button>
      </div>
    </Modal>
  )
}
