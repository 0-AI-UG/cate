import type { MultiWorkspaceSession, SessionSnapshot } from '../shared/types'

type SessionData = MultiWorkspaceSession | SessionSnapshot

export interface HydratedSessionTrust<T extends SessionData> {
  sanitizedSession: T
  acceptedRoots: string[]
}

function isMultiWorkspaceSession(data: SessionData): data is MultiWorkspaceSession {
  return (data as MultiWorkspaceSession).version === 2 || Array.isArray((data as MultiWorkspaceSession).workspaces)
}

export async function hydrateSessionTrust<T extends SessionData>(
  session: T,
  validateRoot: (rootPath: string) => Promise<string | null>,
): Promise<HydratedSessionTrust<T>> {
  const acceptedRoots = new Set<string>()

  const sanitizeSnapshot = async (snapshot: SessionSnapshot): Promise<SessionSnapshot> => {
    if (!snapshot.rootPath) return snapshot
    const trustedRoot = await validateRoot(snapshot.rootPath)
    if (!trustedRoot) {
      return { ...snapshot, rootPath: null }
    }
    acceptedRoots.add(trustedRoot)
    return { ...snapshot, rootPath: trustedRoot }
  }

  if (isMultiWorkspaceSession(session)) {
    const workspaces = await Promise.all(session.workspaces.map(sanitizeSnapshot))
    return {
      sanitizedSession: { ...session, workspaces } as T,
      acceptedRoots: Array.from(acceptedRoots),
    }
  }

  const sanitizedSession = await sanitizeSnapshot(session)
  return {
    sanitizedSession: sanitizedSession as T,
    acceptedRoots: Array.from(acceptedRoots),
  }
}
