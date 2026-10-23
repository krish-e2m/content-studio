import { createContext, useContext } from 'react'

// Holds the loaded client list + its setter, shared across every route.
export const ClientsContext = createContext(null)

export function useClients() {
  const ctx = useContext(ClientsContext)
  if (!ctx) throw new Error('useClients must be used within <ClientsContext.Provider>')
  return ctx
}
