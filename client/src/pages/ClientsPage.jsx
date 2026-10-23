import { useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../icons.jsx'
import { ClientLogo } from '../components/ClientLogo.jsx'
import { Modal } from '../components/Modal.jsx'
import { TopNav } from '../components/TopNav.jsx'
import { useClients } from '../context/ClientsContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { deleteClient } from '../api.js'
import { colorFor } from '../data.js'
import { platformName } from '../lib/clientModel.js'

// Card enter/exit + reposition motion. `show` staggers by index on first load;
// AnimatePresence handles the exit, and `layout` slides survivors when the
// filtered set changes (no snap/jitter).
const cardV = {
  hidden: { opacity: 0, y: 18, scale: 0.96, filter: 'blur(6px)' },
  show: (i) => ({
    opacity: 1, y: 0, scale: 1, filter: 'blur(0px)',
    transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1], delay: (i || 0) * 0.05 },
  }),
  exit: { opacity: 0, scale: 0.9, filter: 'blur(6px)', transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } },
}
const layoutSpring = { type: 'spring', stiffness: 420, damping: 34 }

// Standalone client chooser at "/". No client is active here, so the top nav
// shows no section tabs - selecting a card enters that client's workspace.
export default function ClientsPage() {
  const { clients, setClients } = useClients()
  // Creating and deleting clients is an admin action; the server rejects it for
  // everyone else, so don't offer it.
  const { isAdmin } = useAuth()
  const navigate = useNavigate()
  const hasClients = clients.length > 0

  const [search, setSearch] = useState('')
  const [industryFilter, setIndustryFilter] = useState('')
  const [channelFilter, setChannelFilter] = useState('')

  // Delete flows through a confirm modal. On success the card is dropped from
  // the shared list (AnimatePresence then animates it out).
  const [confirmTarget, setConfirmTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const closeConfirm = () => { if (!deleting) { setConfirmTarget(null); setDeleteError('') } }
  const confirmDelete = async () => {
    if (!confirmTarget || deleting) return
    setDeleting(true)
    setDeleteError('')
    try {
      await deleteClient(confirmTarget.id)
      setClients((prev) => prev.filter((c) => c.id !== confirmTarget.id))
      setConfirmTarget(null)
    } catch (e) {
      setDeleteError(e.message || 'Something went wrong deleting this client.')
    } finally {
      setDeleting(false)
    }
  }

  // Filter option lists derived from the loaded clients, so we only offer
  // industries / channels that actually exist.
  const industries = useMemo(
    () => [...new Set(clients.map((c) => c.industry).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [clients],
  )
  const channelIds = useMemo(
    () => [...new Set(clients.flatMap((c) => (c.social_media_accounts || []).map((s) => s.platform)).filter(Boolean))],
    [clients],
  )

  const hasFilters = Boolean(search.trim() || industryFilter || channelFilter)
  const resetFilters = () => { setSearch(''); setIndustryFilter(''); setChannelFilter('') }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return clients.filter((c) => {
      const accounts = c.social_media_accounts || []
      if (industryFilter && (c.industry || '') !== industryFilter) return false
      if (channelFilter && !accounts.some((s) => s.platform === channelFilter)) return false
      if (!q) return true
      const hay = [
        c.name, c.who, c.contact_name, c.industry, c.tag, c.tagline, c.slug, c.website_url,
        ...accounts.map((s) => platformName(s.platform)),
        ...accounts.map((s) => s.handle),
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [clients, search, industryFilter, channelFilter])

  const showNoResults = hasFilters && filtered.length === 0

  return (
    <div className="app">
      <TopNav crumb={hasClients ? `${clients.length} client${clients.length === 1 ? '' : 's'}` : 'No client yet'} />
      <div className="main">
        <div className="view">
          <div className="page-head">
            <h1>Whose content are we <em style={{ fontStyle: 'italic', color: 'var(--rose-deep)' }}>making</em> today?</h1>
          </div>

          {hasClients && (
            <div className="list-filters">
              <div className="search-box">
                <Icon.Search width={15} height={15} />
                <input
                  className="field search-input"
                  value={search}
                  placeholder="Search by name, contact, industry, channel…"
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && <button className="search-clear" aria-label="Clear search" onClick={() => setSearch('')}>×</button>}
              </div>
              <select className="field filter-select" value={industryFilter} onChange={(e) => setIndustryFilter(e.target.value)} disabled={!industries.length} aria-label="Filter by industry">
                <option value="">All industries</option>
                {industries.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <select className="field filter-select" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} disabled={!channelIds.length} aria-label="Filter by channel">
                <option value="">All channels</option>
                {channelIds.map((id) => <option key={id} value={id}>{platformName(id)}</option>)}
              </select>
              {hasFilters && (
                <div className="filter-actions">
                  <span className="cf-count">{filtered.length} of {clients.length}</span>
                  <button className="btn btn-ghost btn-sm" onClick={resetFilters}>Clear</button>
                </div>
              )}
            </div>
          )}

          {/* Both branches are motion.div at the same position in the tree, so
              without distinct keys React reuses the instance and Framer Motion's
              animation state carries over: clearing a no-match search left the
              grid stuck at the no-results panel's initial opacity: 0, so the
              cards were laid out correctly but invisible. Explicit keys force a
              real unmount/mount. `animate` on the grid is a second guard so it
              can never be left mid-animation. */}
          {showNoResults ? (
            <motion.div key="clients-no-results" className="card clients-no-results"
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
              <Icon.Search width={22} height={22} />
              <p>No clients match your search.</p>
              <button className="btn btn-ghost btn-sm" onClick={resetFilters}>Clear filters</button>
            </motion.div>
          ) : (
          <motion.div key="clients-grid" className="client-grid" layout initial={false} animate={{ opacity: 1 }}>
            <AnimatePresence mode="popLayout">
              {filtered.map((c, i) => {
                const accent = c.accent || colorFor(c.slug || c.name)
                const channels = c.social_media_accounts || []
                const shownChannels = channels.slice(0, 3)
                const extraChannels = channels.length - shownChannels.length
                const subtitle = [c.who || c.contact_name, c.industry].filter(Boolean).join(' · ')
                return (
                  <motion.div key={c.id} className="card client-card" role="button" tabIndex={0}
                    layout custom={i} variants={cardV} initial="hidden" animate="show" exit="exit"
                    transition={{ layout: layoutSpring }}
                    whileHover={{ y: -3, scale: 1.02, transition: { duration: 0.22 } }} whileTap={{ scale: 0.98 }}
                    onClick={() => navigate(`/clients/${c.id}`)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && navigate(`/clients/${c.id}`)}>
                    <span className="client-accent" style={{ background: accent }} />
                    <div className="client-head">
                      <ClientLogo className="client-avatar" src={c.logo} fallback={c.name.charAt(0)} fallbackStyle={{ background: accent }} />
                      <span className="pill">{c.tag || c.tagline || 'Client'}</span>
                    </div>
                    <h3>{c.name}</h3>
                    <p className="client-who">{subtitle || 'No contact yet'}</p>

                    <div className="client-channels">
                      <span className="cc-label">Channels</span>
                      {channels.length === 0 ? (
                        <span className="cc-empty">Not set up yet</span>
                      ) : (
                        <span className="cc-list">
                          {shownChannels.map((s, j) => (
                            <span key={j} className="cc-chip">{platformName(s.platform)}</span>
                          ))}
                          {extraChannels > 0 && <span className="cc-chip cc-more">+{extraChannels}</span>}
                        </span>
                      )}
                    </div>

                    <div className="client-foot">
                      <button className="link-btn" onClick={(e) => { e.stopPropagation(); navigate(`/clients/${c.id}/brain`) }}>Brand brain</button>
                      <span className="client-foot-right">
                        <span className="cf-count">{channels.length} channel{channels.length === 1 ? '' : 's'}</span>
                        {isAdmin && (
                          <button className="client-del" title="Delete client" aria-label={`Delete ${c.name}`}
                            onClick={(e) => { e.stopPropagation(); setDeleteError(''); setConfirmTarget(c) }}>
                            <Icon.Trash width={14} height={14} />
                          </button>
                        )}
                      </span>
                    </div>
                  </motion.div>
                )
              })}

              {!hasFilters && isAdmin && (
                <motion.button key="__add" className="card add-tile"
                  layout custom={filtered.length} variants={cardV} initial="hidden" animate="show" exit="exit"
                  transition={{ layout: layoutSpring }}
                  whileHover={{ y: -3, scale: 1.02, transition: { duration: 0.22 } }} whileTap={{ scale: 0.98 }}
                  onClick={() => navigate('/clients/new')}>
                  <span className="plus"><Icon.Plus width={18} height={18} /></span>
                  <span style={{ fontFamily: 'var(--display)', fontSize: '15px', fontWeight: 600, color: 'var(--ink)' }}>Add a client</span>
                  <span className="tag">Name · channels · brand brain</span>
                </motion.button>
              )}
            </AnimatePresence>
          </motion.div>
          )}
        </div>
      </div>

      {confirmTarget && (
        <Modal title="Delete this client?" onClose={closeConfirm}>
          <div className="confirm-body">
            <span className="confirm-icon"><Icon.Trash width={20} height={20} /></span>
            <p className="confirm-text">
              <strong>“{confirmTarget.name}”</strong> will be permanently removed from your workspace, along with its research, ideas and content. This can’t be undone.
            </p>
          </div>
          {deleteError && <div className="lock-note" style={{ marginBottom: 14 }}>{deleteError}</div>}
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={closeConfirm} disabled={deleting}>Cancel</button>
            <button className="btn btn-danger" onClick={confirmDelete} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete client'}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
