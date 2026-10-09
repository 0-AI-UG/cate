// A workspace's connection as the sidebar shows it, as a dot in the row's
// expand toggle: connecting, offline with when it was last seen, refused, or
// incompatible. Whatever the trouble, it is resolved in that workspace (its
// ConnectionBlocker), never in a dialog over the app (7.10).

import { ChevronRight as CaretRight } from 'lucide-react'
import { useConnectionState } from '../../client/connections'
import { connectionLabel, connectionRemedy, type ConnectionState, type WorkspaceConnection } from '@client/connections'
import { selectWorkspace } from '../navigation'

/** The dot color of a connection state. */
export function connectionDotClass(state: ConnectionState): string {
  const busy = state.kind === 'connecting' || (state.kind === 'offline' && state.retrying)
  if (state.kind === 'incompatible') return 'bg-amber-400'
  if (state.kind === 'stopped') return 'bg-zinc-400'
  return busy ? 'bg-amber-400 animate-pulse motion-reduce:animate-none' : 'bg-red-500'
}

/** What the person can do about a connection state, if anything. */
export function connectionAction(connection: WorkspaceConnection | undefined, state: ConnectionState): { label: string; run: () => void } | null {
  if (!connection) return null
  switch (connectionRemedy(state)) {
    case 'resolve': return { label: 'Resolve…', run: () => void selectWorkspace(connection.workspaceId) }
    case 'retry': return { label: 'Retry now', run: () => connection.retryNow() }
    case 'start': return { label: 'Start again', run: () => connection.retryNow() }
    default: return null
  }
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
  const label = connectionLabel(state)

  return (
    <button
      className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-muted hover:text-primary focus:outline-none"
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

/** The connection's trouble as one line (the Runtime settings page). Connecting says nothing: it is usually over in a beat. */
export function ConnectionNotice({ connection }: { connection: WorkspaceConnection | undefined }): JSX.Element | null {
  const state = useConnectionState(connection)
  if (!connection || (state.kind !== 'offline' && state.kind !== 'refused' && state.kind !== 'incompatible' && state.kind !== 'stopped')) return null
  return (
    <div data-connection-notice className="mx-1.5 mb-1 pl-7 pr-2 text-[12px] text-muted truncate" title={connectionLabel(state) ?? undefined}>
      {connectionLabel(state)}
    </div>
  )
}
