// A workspace whose runtime is not connected, for whatever reason, cannot be
// used: its content is covered and inert until the connection is back. The
// cover says what is wrong and offers the action that fixes it. It covers
// this workspace only: the sidebar and other workspaces stay usable. An
// incompatible runtime is resolved right here (RuntimeMismatchCard), which
// stays up through the restart of an update. Every other state shows the
// core's status (`connectionStatus`) and its actions, and while the
// connection waits for a runtime install (this device's, or the machine's),
// how far it is.
//
// A dip that recovers quickly (a reconnect) is not worth a flash, so
// connecting and offline cover only after a short grace; incompatible,
// refused and stopped cover at once.
//
// It covers a workspace that was shown already; until then WorkspaceGate
// (opening/) shows the workspace's opening surface, with the same cards.

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { BACKDROP, ModalCard, btn, Spinner } from '../../kernel/interaction'
import type { ConnectionState, WorkspaceConnection } from '@client/connections'
import { machineLabel } from '@runtime/daemon/contract'
import { useConnectionState } from '../../client/connections'
import { tryClientApp } from '../app'
import { connectionActions, connectionDotClass, statusOf, type ConnectionAction } from '../sidebar/connectionStatus'
import { RuntimeMismatchCard, useRuntimeUpdate } from './RuntimeMismatch'
import { InstallProgressView, installTargetOf, useInstallProgress } from './installProgress'

const GRACE_MS = 400
const noop = () => () => {}

export function useWorkspaceConnection(workspaceId: string | null): WorkspaceConnection | undefined {
  const connections = tryClientApp()?.connections
  return useSyncExternalStore(
    connections?.subscribe ?? noop,
    () => (workspaceId ? connections?.get(workspaceId) : undefined),
  )
}

/** Whether the state blocks the workspace (closed: it is being closed). */
const blocks = (state: ConnectionState) => state.kind !== 'connected' && state.kind !== 'closed'

/** The connection of `workspaceId` and whether it blocks the workspace now. */
export function useWorkspaceBlock(workspaceId: string | null): { blocked: boolean; connection: WorkspaceConnection | undefined; state: ConnectionState; updating: boolean } {
  const connection = useWorkspaceConnection(workspaceId)
  const state = useConnectionState(connection)
  const updating = useRuntimeUpdate(connection) !== null
  const immediate = updating || state.kind === 'incompatible' || state.kind === 'refused' || state.kind === 'stopped'
  const [graced, setGraced] = useState(false)
  useEffect(() => {
    if (!blocks(state) || immediate) { setGraced(false); return }
    const timer = setTimeout(() => setGraced(true), GRACE_MS)
    return () => clearTimeout(timer)
  }, [state, immediate])
  return { blocked: !!connection && blocks(state) && (immediate || graced), connection, state, updating }
}

/** Covers `children` (the workspace's windows) while its connection blocks. */
export function ConnectionBlocker({ workspaceId, children }: { workspaceId: string | null; children: ReactNode }): JSX.Element {
  const { blocked, connection, state, updating } = useWorkspaceBlock(workspaceId)
  const content = useRef<HTMLDivElement>(null)

  // `inert` keeps focus, typing and shortcuts out of the covered panels.
  useEffect(() => {
    const el = content.current
    if (!el) return
    if (blocked) el.setAttribute('inert', '')
    else el.removeAttribute('inert')
  }, [blocked])

  return (
    <div className="relative h-full">
      <div ref={content} className="h-full">{children}</div>
      {blocked && (
        <div className={`absolute inset-0 z-[1000] flex items-center justify-center ${BACKDROP}`} data-connection-blocker>
          {(state.kind === 'incompatible' || updating) && connection
            ? <RuntimeMismatchCard connection={connection} />
            : <ConnectionStatusCard workspaceId={workspaceId} connection={connection} state={state} />}
        </div>
      )}
    </div>
  )
}

/** The connection's status and remedies (`connectionStatus`), with how far
 *  a runtime install it waits for is. */
export function ConnectionStatusCard({ workspaceId, connection, state }: { workspaceId: string | null; connection: WorkspaceConnection | undefined; state: ConnectionState }): JSX.Element {
  const status = statusOf(connection, state)
  const actions = connectionActions(connection, state)
  const entry = workspaceId ? tryClientApp()?.workspaces.get(workspaceId) : undefined
  const install = useInstallProgress(state.kind === 'connecting' ? installTargetOf(entry) : null)
  return (
    <StatusCard
      title={status?.title}
      message={install ? 'Cate installs its runtime first. This can take a few minutes.' : status?.message}
      busy={state.kind === 'connecting'}
      dotClass={connectionDotClass(state)}
      actions={actions}
    >
      {install && <div className="mt-1"><InstallProgressView progress={install} where={entry?.kind === 'machine' ? machineLabel(entry.machine) : undefined} /></div>}
    </StatusCard>
  )
}

export function StatusCard({ title, message, busy = false, dotClass, actions = [], children }: {
  title?: string
  message?: string
  busy?: boolean
  dotClass?: string
  actions?: ConnectionAction[]
  children?: ReactNode
}): JSX.Element {
  return (
    <ModalCard className="w-[360px] max-w-[92%]" bodyClassName="px-5 py-4">
      <div role="status" className="flex flex-col gap-2">
        <span className="flex items-center gap-2 text-[14px] font-semibold text-primary">
          {busy ? <Spinner size={13} /> : <span className={`w-2 h-2 rounded-full ${dotClass ?? 'bg-zinc-400'}`} />}
          {title}
        </span>
        <span className="text-[13px] leading-relaxed text-secondary break-words">{message}</span>
        {children}
        {actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {actions.map((action, i) => (
              <button key={action.label} type="button" className={i === 0 ? btn.primary : btn.secondary} onClick={action.run}>
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </ModalCard>
  )
}
