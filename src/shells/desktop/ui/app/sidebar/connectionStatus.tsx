// A workspace's connection as the sidebar shows it, as a dot in the row's
// expand toggle: connecting, offline with when it was last seen, refused, or
// incompatible. Whatever the trouble, it is resolved in that workspace (its
// ConnectionBlocker), never in a dialog over the app (7.10).

import { ChevronRight as CaretRight } from 'lucide-react'
import { useConnectionState } from '../../client/connections'
import { connectionStatus, type ConnectionRemedy, type ConnectionState, type ConnectionStatus, type WorkspaceConnection } from '@client/connections'
import { tryClientApp } from '../app'
import { runWindowAction } from '../actions/run'
import { closeWorkspace, openLocalFolder, selectWorkspace } from '../navigation'
import { useUIStore } from '../state/uiStore'

/** The dot color of a connection state. It pulses only while connecting:
 *  an offline connection that keeps retrying is a steady amber, since it
 *  retries for as long as the workspace is open and mostly waits. */
export function connectionDotClass(state: ConnectionState): string {
  if (state.kind === 'incompatible') return 'bg-amber-400'
  if (state.kind === 'stopped') return 'bg-zinc-400'
  if (state.kind === 'connecting') return 'bg-amber-400 animate-pulse motion-reduce:animate-none'
  return state.kind === 'offline' && state.retrying ? 'bg-amber-400' : 'bg-red-500'
}

/** The connection's state in words; null when connected or there is no
 *  connection. */
export function statusOf(connection: WorkspaceConnection | undefined, state: ConnectionState): ConnectionStatus | null {
  return connection ? connectionStatus(state, { startsRuntime: connection.startsRuntime, version: tryClientApp()?.version ?? '' }) : null
}

export interface ConnectionAction {
  label: string
  run: () => void
}

function remedyAction(connection: WorkspaceConnection, state: ConnectionState, remedy: ConnectionRemedy): ConnectionAction | null {
  const workspaces = tryClientApp()?.workspaces
  const id = connection.workspaceId
  switch (remedy) {
    // The workspace's card runs the update and says what it ends.
    case 'updateRuntime': return { label: 'Update…', run: () => void selectWorkspace(id) }
    case 'updateApp': return { label: 'Check for Updates…', run: () => runWindowAction('checkForUpdates') }
    case 'retry': return { label: 'Try again', run: () => connection.retryNow() }
    case 'start': return { label: 'Start again', run: () => connection.retryNow() }
    // A paired one asks first.
    case 'close': return { label: workspaces?.get(id)?.kind === 'paired' ? 'Close Workspace…' : 'Close Workspace', run: () => void closeWorkspace(id) }
    case 'pair': {
      const entry = workspaces?.get(id)
      const machine = entry?.kind === 'paired' ? entry.machineName : undefined
      return { label: 'Pair again…', run: () => useUIStore.getState().openJoinDialog(machine ? { machine } : {}) }
    }
    case 'openNested': {
      if (state.kind !== 'refused' || !state.nestedIn) return null
      const outer = state.nestedIn
      const name = outer.split(/[\\/]/).filter(Boolean).pop() ?? outer
      return { label: `Open ${name}`, run: () => void openLocalFolder(outer) }
    }
  }
}

/** What the person can do about a connection state, main action first. */
export function connectionActions(connection: WorkspaceConnection | undefined, state: ConnectionState): ConnectionAction[] {
  const status = statusOf(connection, state)
  if (!connection || !status) return []
  return status.remedies.map((remedy) => remedyAction(connection, state, remedy)).filter((a): a is ConnectionAction => a !== null)
}

/** A workspace row's expand toggle. While the connection is not connected it
 *  is a status dot instead, and clicking it opens the workspace, whose
 *  ConnectionBlocker says what is wrong and how to fix it. */
export function WorkspaceToggle({ connection, canExpand, expanded, onToggle }: {
  connection: WorkspaceConnection | undefined
  canExpand: boolean
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  const state = useConnectionState(connection)
  const status = statusOf(connection, state)
  const label = status ? `${status.title}: ${status.message}` : null

  return (
    <button
      className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-muted hover:text-primary focus:outline-none"
      title={label ?? undefined}
      onClick={(e) => {
        e.stopPropagation()
        if (label && connection) void selectWorkspace(connection.workspaceId)
        else if (canExpand) onToggle()
      }}
      aria-label={label ?? (canExpand ? (expanded ? 'Collapse workspace' : 'Expand workspace') : undefined)}
      data-connection-status={label ? state.kind : undefined}
      disabled={!canExpand && !label}
    >
      {label
        ? <span className={`w-2 h-2 rounded-full ${connectionDotClass(state)}`} />
        : canExpand && <CaretRight size={10} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />}
    </button>
  )
}

/** The connection's trouble as one line (the Availability settings page). Connecting says nothing: it is usually over in a beat. */
export function ConnectionNotice({ connection }: { connection: WorkspaceConnection | undefined }): JSX.Element | null {
  const state = useConnectionState(connection)
  const status = statusOf(connection, state)
  if (!status || state.kind === 'connecting') return null
  return (
    <div data-connection-notice className="mx-1.5 mb-1 pl-7 pr-2 text-[12px] text-muted truncate" title={status.message}>
      {status.title}: {status.message}
    </div>
  )
}
