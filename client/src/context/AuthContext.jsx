import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { fetchMe, getToken, login as apiLogin, logout as apiLogout, setUnauthorizedHandler } from '../api.js'

// Who's signed in, and what they're allowed to see.
//   status: 'loading' | 'signed-in' | 'signed-out'
//   user:   { id, email, fullName, role, clientIds, isAdmin } | null
//
// `clientIds` is informational for the UI only — the server independently
// filters every request, so hiding something here is presentation, not security.
const AuthContext = createContext({
  status: 'loading',
  user: null,
  isAdmin: false,
  signIn: async () => {},
  signOut: () => {},
})

export const useAuth = () => useContext(AuthContext)

const hasStoredSession = () =>
  Boolean(getToken() || localStorage.getItem('studio.refresh'))

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [status, setStatus] = useState(hasStoredSession() ? 'loading' : 'signed-out')

  // A stored token might be expired; refresh + /auth/me before trusting it.
  useEffect(() => {
    if (!hasStoredSession()) { setStatus('signed-out'); return }
    let alive = true
    fetchMe()
      .then((u) => { if (alive) { setUser(u); setStatus('signed-in') } })
      .catch(() => { if (alive) { apiLogout(); setUser(null); setStatus('signed-out') } })
    return () => { alive = false }
  }, [])

  // Any 401 from any request drops us back to signed-out, so an expired session
  // doesn't leave a half-broken page behind. (api.js already tried refresh first.)
  useEffect(() => {
    setUnauthorizedHandler(() => { setUser(null); setStatus('signed-out') })
    return () => setUnauthorizedHandler(null)
  }, [])

  const signIn = useCallback(async (email, password) => {
    const u = await apiLogin(email, password)
    setUser(u)
    setStatus('signed-in')
    return u
  }, [])

  const signOut = useCallback(() => {
    apiLogout()
    setUser(null)
    setStatus('signed-out')
  }, [])

  return (
    <AuthContext.Provider value={{ status, user, isAdmin: !!user?.isAdmin, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}
