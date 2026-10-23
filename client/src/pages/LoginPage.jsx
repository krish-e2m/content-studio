import { useCallback, useEffect, useRef, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { PasswordField } from '../components/PasswordField.jsx'
import { Icon } from '../icons.jsx'
import { useAuth } from '../context/AuthContext.jsx'

/* Backdrop decoration counts. Fixed so every position and timing can live in
   CSS (:nth-child) instead of inline styles - the marks in particular have to
   land on exact 32px multiples to sit on the drafting rule. */
const MOTES = [0, 1, 2, 3, 4, 5, 6]
const TICKS = [0, 1, 2, 3, 4, 5]

export default function LoginPage() {
  const { status, signIn } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  /* Cursor-following bloom. Written straight to CSS custom props on the
     backdrop node - putting the pointer in state would re-render the form on
     every mousemove. rAF-coalesced so a 240Hz mouse still paints once a frame. */
  const bgRef = useRef(null)
  const frame = useRef(0)
  const point = useRef({ x: 0, y: 0 })

  const trackPointer = useCallback((e) => {
    point.current = { x: e.clientX, y: e.clientY }
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const el = bgRef.current
      if (!el) return
      const { x, y } = point.current
      el.style.setProperty('--mx', `${(x / window.innerWidth) * 100}%`)
      el.style.setProperty('--my', `${(y / window.innerHeight) * 100}%`)
      el.style.setProperty('--lit', '1')
    })
  }, [])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // Already signed in → go where they were headed (or the client list).
  if (status === 'signed-in') {
    return <Navigate to={location.state?.from || '/'} replace />
  }

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await signIn(email.trim(), password)
    } catch (err) {
      setError(err.message || 'Could not sign in')
      setBusy(false)
    }
  }

  return (
    <div className="auth" onPointerMove={trackPointer}>
      {/* Layered backdrop, bottom to top: ink base -> drifting blooms -> drafting
          rule -> calendar marks -> travelling beam -> motes -> cursor bloom ->
          grain + vignette. Order matters: the beam sits above the grid so the
          rule brightens as the light crosses it. Purely decorative, so the whole
          stack is hidden from assistive tech. */}
      <div className="auth-bg" ref={bgRef} aria-hidden="true">
        <div className="auth-bloom" />
        <div className="auth-bloom alt" />
        <div className="auth-grid" />
        <div className="auth-ticks">
          {TICKS.map((i) => (
            <span key={i} />
          ))}
        </div>
        <div className="auth-beam" />
        <div className="auth-motes">
          {MOTES.map((i) => (
            <span key={i} />
          ))}
        </div>
        <div className="auth-spot" />
        <div className="auth-grain" />
      </div>

      <form className="card auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <span className="brand-mark lg">C</span>
          <span className="brand-name">Content Studio</span>
        </div>

        <h1 className="auth-title">Sign in</h1>
        <p className="auth-sub">Your content workspace, scoped to the clients you work on.</p>

        {error && <div className="gen-error auth-error">{error}</div>}

        <label className="auth-field">
          <span className="label">Email</span>
          <input
            className="field"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            placeholder="you@company.com"
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        </label>

        <div className="auth-field">
          <PasswordField
            label="Password"
            value={password}
            placeholder="••••••••"
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </div>

        <button className="btn btn-primary auth-submit" type="submit" disabled={busy || !email.trim() || !password}>
          {busy ? 'Signing in…' : <>Sign in <Icon.Arrow className="arrow" /></>}
        </button>

        <p className="auth-foot">Accounts are created by an admin. Ask yours if you need access.</p>
      </form>
    </div>
  )
}
