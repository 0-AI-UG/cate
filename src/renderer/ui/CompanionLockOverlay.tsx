import { useCallback, useState } from 'react'
import { CloudWarning, CloudArrowDown, CircleNotch, PlugsConnected } from '@phosphor-icons/react'
import { useAppStore, useSelectedWorkspace } from '../stores/appStore'
import { workspaceRuntime } from '../lib/workspaceRuntime'
import { RemoteConnectDialog } from '../dialogs/RemoteConnectDialog'
import type { CompanionConnection, RemoteConnectSpec } from '../../shared/types'

// Full-cover lock for the main canvas while the selected remote workspace's
// companion isn't usable. It blocks interaction with the dead panels beneath and
// offers the recovery action that fits the current phase. Scoped to the canvas
// host only (z-10, under the z-20 sidebars), so the sidebar stays live and the
// user can switch workspaces. Renders nothing for local / connected workspaces —
// the single source of truth is workspaceRuntime(workspace).

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

  // Editable (local or connected) → no lock at all.
  if (!workspace || runtime.editable) return null

  const connection = workspace.connection
  const label = connectionLabel(connection)
  const isBusy = runtime.status === 'installing' || runtime.status === 'connecting'

  // Per-phase copy + actions. The phase is whatever main's probe reported; the
  // overlay only maps it to copy + the action that recovers from it. Each button
  // is opt-in per phase so we only show what actually fixes that state:
  //   - disconnected (was live, channel dropped): the connection is known-good,
  //     so Reconnect; Delete as an escape hatch. Editing the connection wouldn't
  //     help, so no Edit.
  //   - missing (host reachable, daemon absent / version mismatch): the
  //     connection is known-good, so Install only. No Edit, nothing to Delete.
  //   - unreachable (couldn't reach host/auth/path, or an initial connect never
  //     bound): the connection details may be wrong, so this is the one phase
  //     that offers Edit connection. Retry/Delete need a stored connection.
  // "Delete companion" → main rm -rf's the host install and re-probes to
  // `missing`, from where the user does a clean Install.
  const view = (() => {
    switch (runtime.status) {
      case 'installing':
        return { icon: 'install' as const, title: 'Installing companion', reason: 'Setting up the companion daemon on the host…' }
      case 'connecting':
        return { icon: 'spin' as const, title: 'Connecting to companion', reason: 'Reaching the companion daemon…' }
      case 'disconnected':
        return {
          icon: 'warn' as const,
          title: 'Companion disconnected',
          reason: runtime.error || 'The companion daemon dropped. Reconnect to keep working.',
          primary: { label: 'Reconnect', onClick: onRetry, icon: 'plug' as const },
          del: true,
        }
      case 'missing':
        return {
          icon: 'install' as const,
          title: 'Companion not installed',
          reason: runtime.error || 'The companion daemon isn’t installed on the host.',
          primary: { label: 'Install Companion', onClick: onInstall, icon: 'install' as const },
        }
      case 'unreachable':
      default:
        return {
          icon: 'warn' as const,
          title: 'Companion not reachable',
          reason: runtime.error || 'Could not reach the companion. Retry, edit the connection, or delete and reinstall it.',
          primary: runtime.hasConnection ? { label: 'Retry', onClick: onRetry, icon: 'plug' as const } : undefined,
          edit: true,
          del: runtime.hasConnection,
        }
    }
  })()

  return (
    <>
      <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-4/80 backdrop-blur-sm select-none">
        <div className="w-[420px] max-w-[90%] flex flex-col items-center gap-3 rounded-lg border border-subtle bg-surface-3 px-6 py-7 shadow-xl">
          {view.icon === 'spin' ? (
            <CircleNotch size={32} className="text-muted animate-spin" />
          ) : view.icon === 'install' ? (
            <CloudArrowDown size={32} weight="fill" className="text-focus-blue animate-pulse" />
          ) : (
            <CloudWarning size={32} weight="fill" className="text-red-400" />
          )}

          <div className="text-center">
            <div className="text-[15px] font-semibold text-primary">{view.title}</div>
            {label && <div className="mt-0.5 text-[12px] text-muted">{label}</div>}
          </div>

          <div className="w-full text-center text-[12px] text-secondary whitespace-pre-wrap break-words max-h-32 overflow-auto rounded bg-surface-2 border border-subtle px-3 py-2">
            {view.reason}
          </div>

          {!isBusy && (
            <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
              {view.primary && (
                <button
                  className="px-3 py-1.5 rounded text-[13px] bg-focus-blue text-white hover:opacity-90 inline-flex items-center gap-1.5"
                  onClick={view.primary.onClick}
                >
                  {view.primary.icon === 'install' ? (
                    <CloudArrowDown size={14} weight="bold" />
                  ) : (
                    <PlugsConnected size={14} weight="bold" />
                  )}
                  {view.primary.label}
                </button>
              )}
              {view.edit && (
                <button
                  className="px-3 py-1.5 rounded text-[13px] bg-surface-2 text-secondary hover:text-primary border border-subtle"
                  onClick={() => setEditing(true)}
                >
                  Edit connection
                </button>
              )}
              {view.del && (
                <button
                  className="px-3 py-1.5 rounded text-[13px] text-muted hover:text-red-400"
                  onClick={onDelete}
                  title="Delete the daemon from the host so you can do a clean install"
                >
                  Delete companion
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
