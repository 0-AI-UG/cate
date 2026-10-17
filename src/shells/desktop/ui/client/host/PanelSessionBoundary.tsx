// The one place a view attaches to its session (11.2 rule 2): acquire the
// session channel while mounted, release it on unmount, and hand the view its
// props. Every view of a panel on this client shares the one channel.

import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PanelRecord } from '@workspace/document/contract'
import type { SessionHandle } from '@client/connections'
import { useClientState } from '../document'
import { LoadingState } from '../../kernel/interaction'
import type { PanelViewProps } from './views'
import { acquireSession, sessionOwner, subscribeSessions } from '@client/host'

/** Whether the panel is on screen: its tab is active, its canvas node is in
 *  view. Hosts that hide a mounted panel provide false. */
export const PanelVisibilityContext = createContext(true)

const noSnapshot = () => null
const noSubscribe = () => () => {}

/** The session handle for a panel while the calling component is mounted. */
export function usePanelSession<S = unknown>(workspaceId: string, panelId: string): SessionHandle<S> | null {
  const owner = useSyncExternalStore(subscribeSessions, () => sessionOwner(workspaceId))
  const [handle, setHandle] = useState<SessionHandle<S> | null>(null)
  // Layout effect: the view mounts before the first paint.
  useLayoutEffect(() => {
    const acquired = acquireSession(workspaceId, panelId) as SessionHandle<S> | null
    setHandle(acquired)
    return () => {
      acquired?.release()
      setHandle(null)
    }
  }, [workspaceId, panelId, owner])
  return handle
}

export function PanelSessionBoundary({
  workspaceId,
  record,
  children,
}: {
  workspaceId: string
  record: PanelRecord
  children: (props: PanelViewProps) => ReactNode
}) {
  const handle = usePanelSession(workspaceId, record.id)
  const visible = useContext(PanelVisibilityContext)
  const focused = useClientState(workspaceId, (s) => s.focusedPanelId === record.id)
  const snapshot = useSyncExternalStore(
    handle ? handle.subscribe : noSubscribe,
    handle ? () => handle.getSnapshot()?.snapshot ?? null : noSnapshot,
  )
  if (!handle) return <LoadingState label="Connecting" className="h-full w-full bg-surface-4 text-sm" />
  return <>{children({
    workspaceId,
    panelId: record.id,
    record,
    session: handle,
    send: handle.send,
    snapshot,
    visible,
    focused,
  })}</>
}
