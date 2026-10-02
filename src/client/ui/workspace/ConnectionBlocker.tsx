// A workspace whose runtime is not connected, for whatever reason, cannot be
// used: its content is covered and inert until the connection is back. The
// cover says what is wrong and offers the action that fixes it (the same
// vocabulary as the sidebar's status popover).
//
// A dip that recovers quickly (a reconnect) is not worth a flash, so
// connecting and offline cover only after a short grace; incompatible and
// refused cover at once.

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { BACKDROP, ModalCard, Spinner, btn } from '@kernel/ui'
import type { ConnectionState, WorkspaceConnection } from '@client/connections'
import { useConnectionState } from '@client/connections/ui'
import { tryClientApp } from '../app'
import { connectionAction, connectionDotClass, connectionLabel, connectionTitle } from '../sidebar/connectionStatus'

const GRACE_MS = 400
const noop = () => () => {}

function useWorkspaceConnection(workspaceId: string | null): WorkspaceConnection | undefined {
  const connections = tryClientApp()?.connections
  return useSyncExternalStore(
    connections?.subscribe ?? noop,
    () => (workspaceId ? connections?.get(workspaceId) : undefined),
  )
}

/** Whether the state blocks the workspace (closed: it is being closed). */
const blocks = (state: ConnectionState) => state.kind !== 'connected' && state.kind !== 'closed'

/** The connection of `workspaceId` and whether it blocks the workspace now. */
export function useWorkspaceBlock(workspaceId: string | null): { blocked: boolean; connection: WorkspaceConnection | undefined; state: ConnectionState } {
  const connection = useWorkspaceConnection(workspaceId)
  const state = useConnectionState(connection)
  const immediate = state.kind === 'incompatible' || state.kind === 'refused'
  const [graced, setGraced] = useState(false)
  useEffect(() => {
    if (!blocks(state) || immediate) { setGraced(false); return }
    const timer = setTimeout(() => setGraced(true), GRACE_MS)
    return () => clearTimeout(timer)
  }, [state, immediate])
  return { blocked: !!connection && blocks(state) && (immediate || graced), connection, state }
}

/** Covers `children` (the workspace's windows) while its connection blocks. */
export function ConnectionBlocker({ workspaceId, children }: { workspaceId: string | null; children: ReactNode }): JSX.Element {
  const { blocked, connection, state } = useWorkspaceBlock(workspaceId)
  const content = useRef<HTMLDivElement>(null)

  // `inert` keeps focus, typing and shortcuts out of the covered panels.
  useEffect(() => {
    const el = content.current
    if (!el) return
    if (blocked) el.setAttribute('inert', '')
    else el.removeAttribute('inert')
  }, [blocked])

  const action = connectionAction(connection, state)
  return (
    <div className="relative h-full">
      <div ref={content} className="h-full">{children}</div>
      {blocked && (
        <div className={`absolute inset-0 z-[1000] flex items-center justify-center ${BACKDROP}`} data-connection-blocker>
          <ModalCard className="w-[360px] max-w-[92%]" bodyClassName="px-5 py-4">
            <div role="status" className="flex flex-col gap-2">
              <span className="flex items-center gap-2 text-[14px] font-semibold text-primary">
                {state.kind === 'connecting' ? <Spinner size={13} /> : <span className={`w-2 h-2 rounded-full ${connectionDotClass(state)}`} />}
                {connectionTitle(state)}
              </span>
              <span className="text-[13px] leading-relaxed text-secondary">{connectionLabel(state)}</span>
              {action && (
                <button type="button" className={`self-start mt-2 ${btn.secondary}`} onClick={action.run}>
                  {action.label}
                </button>
              )}
            </div>
          </ModalCard>
        </div>
      )}
    </div>
  )
}
