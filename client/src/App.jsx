import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { ClientsContext } from './context/ClientsContext.jsx'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { BootScreen } from './components/BootScreen.jsx'
import { ClientsPageSkeleton } from './components/Skeleton.jsx'
import { decorateClient } from './lib/clientModel.js'
import { listClients } from './api.js'
import LoginPage from './pages/LoginPage.jsx'
import UsersPage from './pages/UsersPage.jsx'
import ClientsPage from './pages/ClientsPage.jsx'
import OnboardingPage from './pages/OnboardingPage.jsx'
import BrandBrainPage from './pages/BrandBrainPage.jsx'
import WorkspaceLayout from './pages/WorkspaceLayout.jsx'
import DashboardPage from './pages/DashboardPage.jsx'
import IdeaBankPage from './pages/IdeaBankPage.jsx'
import ResearchPage from './pages/ResearchPage.jsx'
import PostsPage from './pages/PostsPage.jsx'
import CalendarPage from './pages/CalendarPage.jsx'
import PhotoLibraryPage from './pages/PhotoLibraryPage.jsx'
import PerformancePage from './pages/PerformancePage.jsx'

// Gate: nothing below renders until we know who's signed in.
function RequireAuth({ children }) {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <ClientsPageSkeleton />
  if (status === 'signed-out') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return children
}

// Admin-only areas. The server enforces this too — this just avoids rendering a
// page the caller's requests would all be rejected from.
function RequireAdmin({ children }) {
  const { isAdmin } = useAuth()
  return isAdmin ? children : <Navigate to="/" replace />
}

// Loads the client list once the caller is known. The server returns only the
// clients they're allowed to see, so this list is already scoped.
function Workspace() {
  const [clients, setClients] = useState(null) // null = loading
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    listClients()
      .then((rows) => {
        if (!alive) return
        setClients(rows.map(decorateClient))
      })
      .catch((e) => alive && setError(e.message))
    return () => { alive = false }
  }, [])

  if (error) return <BootScreen title="Couldn't load clients" sub={error} />
  if (clients === null) return <ClientsPageSkeleton />

  return (
    <ClientsContext.Provider value={{ clients, setClients }}>
      <Routes>
        <Route path="/" element={<ClientsPage />} />
        <Route path="/users" element={<RequireAdmin><UsersPage /></RequireAdmin>} />
        <Route path="/clients/new" element={<RequireAdmin><OnboardingPage /></RequireAdmin>} />
        <Route path="/clients/:clientId/brain" element={<BrandBrainPage />} />
        <Route path="/clients/:clientId" element={<WorkspaceLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="research" element={<ResearchPage />} />
          <Route path="ideas" element={<IdeaBankPage />} />
          <Route path="posts" element={<PostsPage />} />
          <Route path="photos" element={<PhotoLibraryPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="performance" element={<PerformancePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ClientsContext.Provider>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/*" element={<RequireAuth><Workspace /></RequireAuth>} />
      </Routes>
    </AuthProvider>
  )
}
