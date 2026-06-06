import { useCallback, useState } from 'react'
import { CloudWarning, CloudArrowDown, CircleNotch, PlugsConnected } from '@phosphor-icons/react'
import { useAppStore, useSelectedWorkspace } from '../stores/appStore'
import { workspaceRuntime } from '../lib/workspace/workspaceRuntime'
import { RemoteConnectDialog } from '../dialogs/RemoteConnectDialog'
import { BACKDROP, CARD_SURFACE, btn } from './Modal'
import type { CompanionConnection, RemoteConnectSpec } from '../../shared/types'

// Full-cover lock for the main canvas while the selected remote workspace's
// companion isn't usable. It blocks interaction with the dead panels beneath and
// offers the recovery action that fits the current phase. Scoped to the canvas
// host only (z-10, under the z-20 sidebars), so the sidebar stays live and the
// user can switch workspaces. For a LOCAL workspace it shows a minimal spinner-
// only loading blocker while the built-in daemon comes up; for a connected
// workspace it renders nothing. The single source of truth is
// workspaceRuntime(workspace) plus the global LOCAL companion phase.

/** Human label for the remote target (distro or user@host) when easy to derive. */
function connectionLabel(connection: CompanionConnection | undefined): string | null {
  if (!connection || connection.kind === 'local') return null
  if (connection.kind === 'wsl') return connection.distro
  return `${connection.user}@${connection.host}`
}

/** Pre-fill values for the edit-connection form from a stored connection. */
function connectionInitial(connection: CompanionConnection | undefined) {
  if (!connection || connection.kind === 'local') return undefined
  if (connection.kind === 'wsl') {
    return { kind: 'wsl' as const, distro: connection.distro, distroPath: connection.distroPath }
  }
  return {
    kind: 'server' as const,
    host: connection.host,
    user: connection.user,
    port: connection.port != null ? String(connection.port) : '',
    remotePath: connection.remotePath,
  }
}

export function CompanionLockOverlay(): JSX.Element | null {
  const workspace = useSelectedWorkspace()
  const retryCompanion = useAppStore((s) => s.retryCompanion)
  const installCompanion = useAppStore((s) => s.installCompanion)
  const deleteCompanion = useAppStore((s) => s.deleteCompanion)
  const connectRemoteWorkspace = useAppStore((s) => s.connectRemoteWorkspace)
  const localCompanionPhase = useAppStore((s) => s.localCompanionPhase)

  const [editing, setEditing] = useState(false)
  const [editPending, setEditPending] = useState(false)

  const wsId = workspace?.id
  const runtime = workspaceRuntime(workspace)

  const onRetry = useCallback(() => { if (wsId) void retryCompanion(wsId) }, [wsId, retryCompanion])
  const onInstall = useCallback(() => { if (wsId) void installCompanion(wsId) }, [wsId, installCompanion])
  const onDelete = useCallback(() => { if (wsId) void deleteCompanion(wsId) }, [wsId, deleteCompanion])
  const onSubmitEdit = useCallback(
    async (spec: RemoteConnectSpec) => {
      if (!wsId) return
      setEditPending(true)
      const ok = await connectRemoteWorkspace(wsId, spec)
      setEditPending(false)
      if (ok) setEditing(false)
    },
    [wsId, connectRemoteWorkspace],
  )

  // Local workspace: a minimal loading blocker — just the blurred block + a
  // spinner, no recovery actions (the local daemon self-heals via auto-reconnect)
  // — while the built-in companion is still coming up (first-run tarball
  // extraction or a reconnect). `null` = not seeded yet, still treated as loading.
  if (workspace && runtime.status === 'local') {
    const loading =
      localCompanionPhase === null ||
      localCompanionPhase === 'connecting' ||
      localCompanionPhase === 'installing'
    if (!loading) return null
    return (
      <div className={`modal-backdrop-in absolute inset-0 z-10 flex items-center justify-center select-none ${BACKDROP}`}>
        <CircleNotch size={24} className="text-muted animate-spin" />
      </div>
    )
  }

  // Editable (connected) → no lock at all.
  if (!workspace || runtime.editable) return null

  const connection = workspace.connection
  const label = connectionLabel(connection)
  const isBusy = runtime.status === 'installing' || runtime.status === 'connecting'

  // Per-phase title + actions. The phase is whatever main's probe reported; the
  // overlay only maps it to a short title + the actions that recover from it.
  // Each button is opt-in per phase so we only show what actually fixes that
  // state: disconnected → Reconnect (+Delete escape hatch); missing → Install;
  // unreachable → Retry + Edit connection (+Delete). The error message, when
  // there is one, is the only body text. "Delete companion" → main rm -rf's the
  // host install and re-probes to `missing`, where the user does a clean Install.
  const view = (() => {
    switch (runtime.status) {
      case 'installing':
        return { icon: 'install' as const, title: 'Installing companion…' }
      case 'connecting':
        return { icon: 'spin' as const, title: 'Connecting…' }
      case 'disconnected':
        return {
          icon: 'warn' as const,
          title: 'Companion disconnected',
          primary: { label: 'Reconnect', onClick: onRetry, icon: 'plug' as const },
          del: true,
        }
      case 'missing':
        return {
          icon: 'install' as const,
          title: 'Companion not installed',
          primary: { label: 'Install', onClick: onInstall, icon: 'install' as const },
        }
      case 'unreachable':
      default:
        return {
          icon: 'warn' as const,
          title: 'Companion unreachable',
          primary: runtime.hasConnection ? { label: 'Retry', onClick: onRetry, icon: 'plug' as const } : undefined,
          edit: true,
          del: runtime.hasConnection,
        }
    }
  })()

  return (
    <>
      <div className={`modal-backdrop-in absolute inset-0 z-10 flex items-center justify-center select-none ${BACKDROP}`}>
        <div className={`modal-card-in w-[300px] max-w-[90%] flex flex-col items-center gap-3 px-6 py-7 ${CARD_SURFACE}`}>
          {view.icon === 'spin' ? (
            <CircleNotch size={24} className="text-muted animate-spin" />
          ) : view.icon === 'install' ? (
            <CloudArrowDown size={24} weight="fill" className="text-focus-blue animate-pulse" />
          ) : (
            <CloudWarning size={24} weight="fill" className="text-red-400" />
          )}

          <div className="text-[13px] font-medium text-primary text-center">{view.title}</div>
          {label && <div className="-mt-2 text-[11px] text-muted">{label}</div>}

          {runtime.error && (
            <div className="w-full text-center text-[11px] text-muted whitespace-pre-wrap break-words max-h-20 overflow-auto">
              {runtime.error}
            </div>
          )}

          {!isBusy && (
            <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
              {view.primary && (
                <button className={btn.primary} onClick={view.primary.onClick}>
                  {view.primary.icon === 'install' ? (
                    <CloudArrowDown size={14} weight="bold" />
                  ) : (
                    <PlugsConnected size={14} weight="bold" />
                  )}
                  {view.primary.label}
                </button>
              )}
              {view.edit && (
                <button className={btn.secondary} onClick={() => setEditing(true)}>
                  Edit
                </button>
              )}
              {view.del && (
                <button
                  className={btn.danger}
                  onClick={onDelete}
                  title="Delete the daemon from the host so you can do a clean install"
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {editing && (
        <RemoteConnectDialog
          initial={connectionInitial(connection)}
          onSubmit={onSubmitEdit}
          onClose={() => setEditing(false)}
          pending={editPending}
          error={editPending ? null : runtime.error}
        />
      )}
    </>
  )
}
