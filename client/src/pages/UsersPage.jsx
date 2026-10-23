import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../icons.jsx'
import { Modal } from '../components/Modal.jsx'
import { PasswordField } from '../components/PasswordField.jsx'
import { ChromeShell } from '../components/ChromeShell.jsx'
import { useClients } from '../context/ClientsContext.jsx'
import { createUser, deleteUser, listUsers, setUserClients, usageSpend } from '../api.js'

const fmtDate = (v) => {
  if (!v) return '—'
  try { return new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) }
  catch { return '—' }
}

// AI spend is genuinely small per call — one post costs fractions of a cent —
// so two decimal places would print most real usage as "$0.00". Anything under
// a cent keeps four places; above that, cents are what an admin reads.
const fmtUsd = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  if (v === 0) return '$0.00'
  if (v < 0.01) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// Admin-only. Create logins and choose which clients each one can see.
export default function UsersPage() {
  const { clients } = useClients()
  const [users, setUsers] = useState(null)   // null = loading
  const [error, setError] = useState('')
  // OpenRouter spend per client. null = still loading. A failure here must not
  // hide the table, so it lands as { ready: false } and the column reads "—".
  const [spend, setSpend] = useState(null)

  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ fullName: '', email: '', password: '', clientIds: [] })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const [editing, setEditing] = useState(null)      // user whose assignments are open
  const [editIds, setEditIds] = useState([])
  const [confirmTarget, setConfirmTarget] = useState(null)
  const [removing, setRemoving] = useState(false)

  const clientName = useMemo(
    () => Object.fromEntries(clients.map((c) => [c.id, c.name])),
    [clients],
  )

  const load = () => {
    setError('')
    listUsers().then(setUsers).catch((e) => { setUsers([]); setError(e.message) })
    usageSpend()
      .then(setSpend)
      .catch((e) => setSpend({ ready: false, byClient: {}, error: e.message }))
  }
  useEffect(load, [])

  const openAdd = () => {
    setForm({ fullName: '', email: '', password: '', clientIds: [] })
    setFormError('')
    setAdding(true)
  }
  const save = async () => {
    if (saving) return
    setSaving(true)
    setFormError('')
    try {
      await createUser({
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        password: form.password,
        clientIds: form.clientIds,
      })
      setAdding(false)
      load()
    } catch (e) {
      setFormError(e.message || 'Could not create the user')
    } finally {
      setSaving(false)
    }
  }

  const saveAssignments = async () => {
    if (saving) return
    setSaving(true)
    try {
      await setUserClients(editing.id, editIds)
      setEditing(null)
      load()
    } catch (e) {
      setFormError(e.message || 'Could not save assignments')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (removing) return
    setRemoving(true)
    try {
      await deleteUser(confirmTarget.id)
      setConfirmTarget(null)
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <ChromeShell crumb="Team">
      <div className="view">
        <div className="page-head page-head-row">
          <div>
            <span className="eyebrow">Team</span>
            <h1>Users &amp; access</h1>
            <p className="lede">Create a login, then choose the one client it can see. Admins see everything. Access is stored on the Supabase auth user, not a separate table.</p>
            <CreditsLine spend={spend} />
          </div>
          <div className="page-head-actions">
            <button className="btn btn-rose btn-sm" onClick={openAdd}><Icon.Plus width={15} height={15} /> Add user</button>
          </div>
        </div>

        {error && <div className="gen-error" style={{ marginBottom: 'var(--sp-4)' }}>{error}</div>}

        {users === null ? (
          <div className="card card-pad"><p className="muted-text">Loading users…</p></div>
        ) : users.length === 0 ? (
          <div className="card idea-empty">
            <span className="plus">+</span>
            <p>No users yet. Add one and assign the client they should work on.</p>
            <button className="btn btn-rose btn-sm" onClick={openAdd}>Add the first user</button>
          </div>
        ) : (
          <div className="card idea-table-wrap">
            <table className="idea-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Client</th>
                  <th>AI spend</th>
                  <th>Added</th>
                  <th className="ta-actions-head">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="ta-title">
                      <span className="ta-name">{u.fullName || u.email.split('@')[0]}</span>
                      <span className="ta-note">{u.email}</span>
                    </td>
                    <td>
                      <span className={`pill ${u.role === 'admin' ? 'solid' : ''}`}>{u.role}</span>
                    </td>
                    <td>
                      {u.role === 'admin' ? (
                        <span className="muted-text">All clients</span>
                      ) : u.clientIds.length === 0 ? (
                        <span className="muted-text">None yet</span>
                      ) : (
                        /* One client per user now, but rows created before that
                           can still carry several - show the first and count the
                           rest rather than hiding them. */
                        <div className="ta-tags">
                          <span className="pill">{clientName[u.clientIds[0]] || 'Unknown'}</span>
                          {u.clientIds.length > 1 && (
                            <span className="pill pill-more">+{u.clientIds.length - 1}</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td><SpendCell user={u} spend={spend} /></td>
                    <td>{fmtDate(u.createdAt)}</td>
                    <td className="ta-actions">
                      <div className="ta-actions-inner">
                        {u.role !== 'admin' && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => { setEditing(u); setEditIds(u.clientIds); setFormError('') }}
                          >Assign client</button>
                        )}
                        {u.role !== 'admin' && (
                          <button className="icon-btn icon-btn-danger" title="Remove user" aria-label="Remove user" onClick={() => setConfirmTarget(u)}>
                            <Icon.Trash width={15} height={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* --- create --- */}
        {adding && (
          <Modal title="Add a user" sub="They'll sign in with this email and password, and see only the client you pick." onClose={() => !saving && setAdding(false)}>
            {formError && <div className="gen-error">{formError}</div>}
            <div className="stack">
              <div><span className="label">Full name</span>
                <input className="field" autoFocus value={form.fullName} placeholder="Jane Cooper" onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
              </div>
              <div><span className="label">Email</span>
                <input className="field" type="email" value={form.email} placeholder="jane@company.com" onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div>
                <PasswordField
                  label="Password"
                  hint="(min 8 characters)"
                  value={form.password}
                  placeholder="Share this with them"
                  autoComplete="new-password"
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </div>
              <div>
                <span className="label">Client they can see</span>
                <ClientSelect clients={clients} ids={form.clientIds} onChange={(ids) => setForm({ ...form, clientIds: ids })} />
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setAdding(false)} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={saving || !form.email.trim() || form.password.length < 8}>
                {saving ? 'Creating…' : 'Create user'}
              </button>
            </div>
          </Modal>
        )}

        {/* --- assignments --- */}
        {editing && (
          <Modal title={`Client for ${editing.fullName || editing.email}`} sub="They'll only see data for the client selected here." onClose={() => !saving && setEditing(null)}>
            {formError && <div className="gen-error">{formError}</div>}
            <span className="label">Client they can see</span>
            <ClientSelect clients={clients} ids={editIds} onChange={setEditIds} />
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setEditing(null)} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" onClick={saveAssignments} disabled={saving}>{saving ? 'Saving…' : 'Save access'}</button>
            </div>
          </Modal>
        )}

        {/* --- remove --- */}
        {confirmTarget && (
          <Modal title="Remove this user?" onClose={() => !removing && setConfirmTarget(null)}>
            <div className="confirm-body">
              <span className="confirm-icon"><Icon.Trash width={20} height={20} /></span>
              <p className="confirm-text">
                <strong>“{confirmTarget.fullName || confirmTarget.email}”</strong> will lose access immediately and their
                login will be deleted. Client data is not affected. This can’t be undone.
              </p>
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmTarget(null)} disabled={removing}>Cancel</button>
              <button className="btn btn-danger" onClick={remove} disabled={removing}>{removing ? 'Removing…' : 'Remove user'}</button>
            </div>
          </Modal>
        )}
      </div>
    </ChromeShell>
  )
}

// A non-admin sees exactly one client, so this is a single select rather than the
// checkbox list it replaced. A multi-select control for a single-choice field
// invites the wrong mental model, and it let an admin save two clients that the
// rest of the app then had no way to present.
//
// The wire format stays an array (`clientIds`) - that is what the API and the
// stored auth metadata use, and keeping it means existing multi-client rows still
// load rather than erroring. `ids` is read as "the first, if any" and written
// back as an array of zero or one.
function ClientSelect({ clients, ids, onChange }) {
  if (clients.length === 0) return <p className="muted-text">No clients exist yet.</p>
  return (
    <>
      <select
        className="field"
        value={ids[0] || ''}
        onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
      >
        <option value="">No client yet</option>
        {clients.map((c) => {
          const n = (c.social_media_accounts || []).length
          return (
            <option key={c.id} value={c.id}>
              {c.name} — {n} channel{n === 1 ? '' : 's'}
            </option>
          )
        })}
      </select>
      {ids.length > 1 && (
        <p className="muted-text" style={{ marginTop: 'var(--sp-2)' }}>
          This user currently has {ids.length} clients from an earlier version. Saving will keep only
          the one selected above.
        </p>
      )}
    </>
  )
}

// --- AI spend ---------------------------------------------------------------
// Every AI feature in the app bills the agency's single OpenRouter key, so
// "who is using how much of the credits" is only answerable if each call is
// attributed to a client. The server does that (see server/usage.js) and this
// column reads the totals back.
//
// A user sees exactly one client, so their row shows that client's spend, not
// their own — two logins on the same client are two views of one bill. Rows
// created before the one-client rule can still carry several, so the amounts
// are summed across whatever the user is assigned.

// Roll a user's assigned clients up into one figure. Returns null when there is
// nothing to show yet, so the caller can distinguish "no spend" from "no data".
function spendForUser(user, spend) {
  if (!spend?.byClient) return null
  if (user.role === 'admin') {
    // An admin isn't scoped to a client, so the only honest figure for a row
    // whose Client cell reads "All clients" is the whole workspace — which also
    // covers spend with no client attached (brand extraction at onboarding).
    const t = spend.total || {}
    return { costUsd: t.costUsd ?? 0, requests: t.requests ?? 0, calls: null, scope: 'workspace total' }
  }
  const ids = user.clientIds || []
  if (!ids.length) return null
  const rows = ids.map((id) => spend.byClient[id]).filter(Boolean)
  if (!rows.length) return { costUsd: 0, requests: 0, calls: 0, scope: null }
  return {
    costUsd: rows.reduce((n, r) => n + (r.costUsd || 0), 0),
    requests: rows.reduce((n, r) => n + (r.requests || 0), 0),
    calls: rows.reduce((n, r) => n + (r.calls || 0), 0),
    unpricedCalls: rows.reduce((n, r) => n + (r.unpricedCalls || 0), 0),
    // OpenRouter's own figure for the same client, when a management key lets
    // us ask. Only shown in the tooltip — it counts tagged calls only, so it
    // reads lower than the ledger rather than contradicting it.
    openRouterCostUsd: rows.some((r) => typeof r.openRouterCostUsd === 'number')
      ? rows.reduce((n, r) => n + (r.openRouterCostUsd || 0), 0)
      : null,
    lastUsedAt: rows.map((r) => r.lastUsedAt).filter(Boolean).sort().pop() || null,
    scope: null,
  }
}

function SpendCell({ user, spend }) {
  if (!spend) return <span className="muted-text">…</span>
  if (spend.ready === false) {
    return (
      <span
        className="muted-text"
        title={spend.error || 'Spend tracking is not available yet — apply the ai_usage migration to start recording it.'}
      >—</span>
    )
  }

  const row = spendForUser(user, spend)
  if (!row) return <span className="muted-text" title="No client assigned, so nothing has been billed for this login.">—</span>

  const amount = fmtUsd(row.costUsd) || '—'
  const note = row.scope
    ? row.scope
    : row.calls === 0
      ? 'no AI usage yet'
      : plural(row.calls, 'call')
  const tip = [
    row.requests ? plural(row.requests, 'billed request') : null,
    row.lastUsedAt ? `last used ${fmtDate(row.lastUsedAt)}` : null,
    row.unpricedCalls ? `${plural(row.unpricedCalls, 'call')} with no cost reported` : null,
    typeof row.openRouterCostUsd === 'number'
      ? `OpenRouter reports ${fmtUsd(row.openRouterCostUsd)} for tagged calls`
      : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className="ta-spend" title={tip || undefined}>
      <span className="ta-spend-amount">{amount}</span>
      <span className="ta-note">{note}</span>
    </div>
  )
}

// Account-wide credit balance, for scale: the per-client column adds up to a
// number that only means something against what the key has to spend. Renders
// nothing without a management key (the /credits endpoint refuses an inference
// key), which is the common case.
function CreditsLine({ spend }) {
  const c = spend?.credits
  if (!c || typeof c.used !== 'number') return null
  const parts = [
    `${fmtUsd(c.used)} used`,
    typeof c.purchased === 'number' ? `of ${fmtUsd(c.purchased)} bought` : null,
    typeof c.remaining === 'number' ? `${fmtUsd(c.remaining)} left` : null,
  ].filter(Boolean)
  return (
    <p className="spend-credits">
      <strong>OpenRouter credits</strong> · {parts.join(' · ')}
    </p>
  )
}
