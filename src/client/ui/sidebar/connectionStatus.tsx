// A workspace's connection as the sidebar shows it: connecting, offline with
// when it was last seen, refused, or incompatible with an update action. The
// update lists what will stop and asks first (7.10).

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Tooltip } from '@kernel/ui'
import { useConnectionState } from '@client/connections/ui'
import type { ConnectionState, WorkspaceConnection } from '@client/connections'
import { documentStoreFor } from '@client/document'
import { RunningWorkConfirm } from '@runtime/daemon/ui'
import { clientApp } from '../app'

/** "5 minutes ago", coarse. */
export function relativeTime(then: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** One line describing a connection state, or null when there is nothing to say. */
export function connectionLabel(state: ConnectionState, now?: number): string | null {
  switch (state.kind) {
    case 'connecting': return 'Connecting…'
    case 'offline':
      return state.lastSeen
        ? `Offline, last seen ${relativeTime(state.lastSeen, now)}${state.retrying ? '. Retrying.' : ''}`
        : `Not reachable${state.error ? `: ${state.error}` : ''}${state.retrying ? '. Retrying.' : ''}`
    case 'incompatible': return `The workspace runtime (${state.runtimeVersion}) needs an update`
    case 'refused': return state.message
    default: return null
  }
}

export function ConnectionDot({ connection }: { connection: WorkspaceConnection | undefined }): JSX.Element | null {
  const state = useConnectionState(connection)
  const label = connectionLabel(state)
  if (!label) return null
  const busy = state.kind === 'connecting' || (state.kind === 'offline' && state.retrying)
  const color = state.kind === 'incompatible'
    ? 'bg-amber-400'
    : busy ? 'bg-amber-400 animate-pulse motion-reduce:animate-none' : 'bg-red-500'
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        className={`flex-shrink-0 w-2 h-2 rounded-full focus:outline-none ${color}`}
        onClick={(e) => {
          e.stopPropagation()
          connection?.retryNow()
        }}
      />
    </Tooltip>
  )
}

/** The notice under an incompatible or unreachable workspace row. */
export function ConnectionNotice({ workspaceId, connection }: { workspaceId: string; connection: WorkspaceConnection | undefined }): JSX.Element | null {
  const state = useConnectionState(connection)
  const [confirming, setConfirming] = useState(false)
  if (!connection || (state.kind !== 'incompatible' && state.kind !== 'offline' && state.kind !== 'refused')) return null
  const label = connectionLabel(state)
  const version = clientApp().version
  return (
    <div className="mx-1.5 mb-1 pl-7 pr-2 flex flex-col gap-1.5 text-[12px] text-muted">
      <span>{label}</span>
      {state.kind === 'incompatible' && !confirming && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="self-start inline-flex items-center gap-1.5 text-blue-400 hover:text-blue-300"
        >
          <RefreshCw size={12} />
          Update runtime to {version}
        </button>
      )}
      {state.kind === 'incompatible' && confirming && (
        <RunningWorkConfirm
          runtime={connection.runtime}
          actionLabel="Update and restart"
          consequence={`Updating installs runtime ${version} and restarts it, which ends everything below for everyone in this workspace.`}
          title={(panelId) => documentStoreFor(workspaceId)?.getSnapshot().panels[panelId]?.title}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            await connection.runtime.runtime.update({ version })
            setConfirming(false)
          }}
        />
      )}
    </div>
  )
}
