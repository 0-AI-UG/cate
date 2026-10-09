// The repository host (workspace/repository/client) the views read, filled
// by the client that shows them.

import { createContext, useContext, type ReactNode } from 'react'
import type { RepositoryHost } from '@workspace/repository/client'

const RepositoryUiContext = createContext<RepositoryHost | null>(null)

export function RepositoryUiProvider({ host, children }: { host: RepositoryHost; children: ReactNode }) {
  return <RepositoryUiContext.Provider value={host}>{children}</RepositoryUiContext.Provider>
}

export function useRepositoryUi(): RepositoryHost {
  const host = useContext(RepositoryUiContext)
  if (!host) throw new Error('RepositoryUiProvider is missing')
  return host
}
