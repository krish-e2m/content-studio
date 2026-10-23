import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { Icon } from '../icons.jsx'
import { ClientLogo } from './ClientLogo.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { DOW, MONTHS } from '../lib/util.js'

// Shared dismiss behaviour for the two poppers in this bar (account menu and the
// narrow-screen drawer): click anywhere outside, or press Escape. Bound on
// pointerdown rather than click so it fires before a button underneath can act.
function useDismiss(ref, close, active) {
  useEffect(() => {
    if (!active) return
    const onDown = (e) => { if (!ref.current?.contains(e.target)) close() }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [ref, close, active])
}

// Up to two initials: first letters of the first two words of a display name,
// falling back to the first two characters of the email local part.
function initialsOf(user) {
  const name = (user.fullName || '').trim()
  if (name) {
    const parts = name.split(/\s+/).slice(0, 2)
    return parts.map((w) => w[0]).join('').toUpperCase()
  }
  return user.email.slice(0, 2).toUpperCase()
}

// The signed-in identity, collapsed to a single avatar. It used to sit in the bar
// as "name + role badge + Sign out", which was three elements of chrome for
// something you look at once a session - and the widest thing in the right-hand
// group, so it was what pushed the tabs off centre.
function AccountMenu({ user, isAdmin, signOut }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const { pathname } = useLocation()

  useDismiss(ref, () => setOpen(false), open)
  useEffect(() => setOpen(false), [pathname])

  const name = user.fullName || user.email.split('@')[0]

  return (
    <div className="tn-acct" ref={ref}>
      <button
        className={`tn-acct-btn ${open ? 'on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${name}`}
        title={`${name} · ${user.role}`}
      >
        {initialsOf(user)}
      </button>

      {open && (
        <div className="tn-pop tn-acct-pop" role="menu">
          <div className="tn-acct-head">
            <span className="tn-acct-face">{initialsOf(user)}</span>
            <span className="tn-acct-id">
              <span className="tn-acct-name">{name}</span>
              <span className="tn-acct-mail" title={user.email}>{user.email}</span>
            </span>
          </div>
          <div className="tn-acct-meta">
            <span className="tn-acct-meta-k">Role</span>
            <em className={`tn-role ${isAdmin ? '' : 'plain'}`}>{user.role}</em>
          </div>
          <button className="tn-pop-item danger" role="menuitem" onClick={signOut}>
            <Icon.SignOut width={15} height={15} />
            <span>Sign out</span>
          </button>
        </div>
      )}
    </div>
  )
}

// Workspace sections, in flow order. Each maps to a nested route under
// /clients/:id, except Profile which lives outside the workspace routes and so
// needs an absolute path.
const TABS = [
  { to: '', end: true, id: 'dashboard', label: 'Overview', icon: Icon.Home },
  { to: 'research', id: 'research', label: 'Research', icon: Icon.Search },
  { to: 'ideas', id: 'ideas', label: 'Idea Bank', icon: Icon.Bulb },
  { to: 'posts', id: 'posts', label: 'Posts', icon: Icon.Pen },
  { to: 'calendar', id: 'calendar', label: 'Calendar', icon: Icon.Calendar },
  { to: 'performance', id: 'performance', label: 'Performance', icon: Icon.BarChart },
  { to: 'photos', id: 'photos', label: 'Photos', icon: Icon.Image },
  { to: 'brain', id: 'brain', label: 'Profile', icon: Icon.Spark },
]

// Section tabs, centred in the nav row. The active pill is a single shared
// element (layoutId), so Framer Motion slides it from the old tab to the new one
// instead of hiding one and showing another.
function TabBar({ client }) {
  const barRef = useRef(null)
  const { pathname } = useLocation()

  // On narrow screens the strip scrolls, so the active tab can sit outside the
  // visible area - which would leave no on-screen indication of the current
  // section. Pull it into view whenever the route changes.
  useEffect(() => {
    const active = barRef.current?.querySelector('.tab.active')
    active?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [pathname])

  return (
    <nav className="tabbar-inner" ref={barRef}>
      {TABS.map((t) => {
        const I = t.icon
        const to = t.to ? `/clients/${client.id}/${t.to}` : `/clients/${client.id}`
        return (
          <NavLink key={t.id} to={to} end={t.end} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId="tab-pill"
                    className="tab-pill"
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
                <span className="tab-label"><I width={15} height={15} /><span>{t.label}</span></span>
              </>
            )}
          </NavLink>
        )
      })}
    </nav>
  )
}

// The app's single navigation row:
//   left   — Studio brand, plus admin shortcuts (Add client / Team)
//   centre — section tabs, centred on the viewport
//   right  — the client you're working in, the account avatar, and (narrow only)
//            the hamburger the admin shortcuts fold into
//
// The active client used to sit immediately right of the brand, and the two read
// as one thing: both were a dark rounded square plus a word. It now lives on the
// far side of the bar with a round avatar and an accent ring, so "which product"
// and "which client" are visually and physically separate.
//
// Everything on the right is a --nav-ctl square or pill, so the bar keeps one
// horizontal band no matter which pieces are showing at a given width.
export function TopNav({ client, crumb }) {
  const navigate = useNavigate()
  const { user, isAdmin, signOut } = useAuth()
  const today = new Date()
  const { pathname } = useLocation()

  // Narrow-screen drawer. It only ever holds the admin shortcuts, so there is
  // nothing to open for a non-admin and the trigger is not rendered for them.
  const [navOpen, setNavOpen] = useState(false)
  const burgerRef = useRef(null)
  useDismiss(burgerRef, () => setNavOpen(false), navOpen)
  useEffect(() => setNavOpen(false), [pathname])

  const go = (to) => { setNavOpen(false); navigate(to) }

  return (
    <header className="topnav">
      <div className="tn-left">
        <button className="brand" onClick={() => navigate('/')} title="All clients">
          <span className="brand-mark">C</span>
          <span className="brand-name">Content Studio</span>
        </button>

        {isAdmin && (
          <>
            <span className="tn-sep" />
            {/* No whitespace between glyph and label in any of these buttons -
                a literal space would stack on top of the flex gap and make the
                icon spacing wider here than on the tabs. */}
            <span className="tn-admin">
              <button className="tn-action" onClick={() => navigate('/clients/new')} title="Add a new client">
                <Icon.Plus width={14} height={14} />
                <span>Add client</span>
              </button>
              <button className="tn-action" onClick={() => navigate('/users')} title="Users & access">
                <Icon.Users width={14} height={14} />
                <span>Team</span>
              </button>
            </span>
          </>
        )}
      </div>

      {client ? <TabBar client={client} /> : <span />}

      <div className="tn-right">
        {/* With tabs on screen the active tab already says where you are, so the
            crumb would only repeat it - show it on the tab-less pages. */}
        {!client && crumb && <span className="tn-crumb">{crumb}</span>}
        {/* Only on the tab-less pages: in the workspace the right-hand group
            (client + account) is wide enough that keeping the date pushed it
            into the centred tabs. */}
        {!client && (
          <span className="tn-date">{DOW[today.getDay()]}, {MONTHS[today.getMonth()]} {today.getDate()}</span>
        )}

        {client && (
          <button className="tn-client" onClick={() => navigate('/')} title={`Working in ${client.name} · switch client`}>
            <ClientLogo
              className="tn-avatar"
              src={client.logo}
              fallback={client.name.charAt(0)}
              fallbackStyle={{ background: client.accent }}
            />
            <span className="tn-client-meta">
              <em className="tn-client-label">Client</em>
              <span className="tn-client-name">{client.name}</span>
            </span>
            <Icon.Grid width={13} height={13} />
          </button>
        )}

        {user && <AccountMenu user={user} isAdmin={isAdmin} signOut={signOut} />}

        {/* Takes over from the admin shortcuts at the 1080px step of the
            responsive ladder in styles.css, where .tn-admin hides. */}
        {isAdmin && (
          <div className="tn-burger-wrap" ref={burgerRef}>
            <button
              className={`tn-burger ${navOpen ? 'on' : ''}`}
              onClick={() => setNavOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={navOpen}
              aria-label="Menu"
            >
              <Icon.Menu width={16} height={16} />
            </button>

            {navOpen && (
              <div className="tn-pop tn-burger-pop" role="menu">
                <span className="tn-pop-label">Admin</span>
                <button className="tn-pop-item" role="menuitem" onClick={() => go('/clients/new')}>
                  <Icon.Plus width={15} height={15} />
                  <span>Add client</span>
                </button>
                <button className="tn-pop-item" role="menuitem" onClick={() => go('/users')}>
                  <Icon.Users width={15} height={15} />
                  <span>Users &amp; access</span>
                </button>
                {client && (
                  <>
                    <span className="tn-pop-label">Workspace</span>
                    <button className="tn-pop-item" role="menuitem" onClick={() => go('/')}>
                      <Icon.Grid width={15} height={15} />
                      <span>Switch client</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  )
}
