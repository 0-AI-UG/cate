import { useCallback } from 'react'
import { CloudWarning, CircleNotch } from '@phosphor-icons/react'
import { useAppStore, useSelectedWorkspace } from '../stores/appStore'

// Full-cover lock for the main canvas when the selected workspace is a remote
// companion (SSH/WSL) whose daemon is down. It blocks interaction with the dead
// panels beneath and offers a reinstall. Scoped to the canvas host only, so the
// sidebar stays live and the user can switch workspaces.

/** Human label for the remote target (distro or user@host) when easy to derive. */
function connectionLabel(connection: NonNullable<ReturnType<typeof useSelectedWorkspace>>['connection']): string | null {
  if (!connection || connection.kind === 'local') return null
  if (connection.kind === 'wsl') return connection.distro
  return `${connection.user}@${connection.host}`
}

export function CompanionLockOverlay(): JSX.Element | null {
  const workspace = useSelectedWorkspace()
  const reinstallCompanion = useAppStore((s) => s.reinstallCompanion)

  const wsId = workspace?.id
  const handleInstall = useCallback(() => {
    if (wsId) void reinstallCompanion(wsId)
  }, [wsId, reinstallCompanion])

  // Only remote companions can be locked. Local (or no connection) → no lock.
  const connection = workspace?.connection
  if (!workspace || !connection || connection.kind === 'local') return null

  const status = workspace.companionStatus
  const isConnecting = status === 'connecting'
  const isDown = status === 'error' || status === 'disconnected'
  // Healthy / connected / undefined-after-connect → render the normal canvas.
  if (!isConnecting && !isDown) return null

  const label = connectionLabel(connection)
  const reason = isConnecting
    ? 'Connecting to the companion daemon…'
    : workspace.rootPathError || 'The companion daemon is not reachable.'

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-4/80 backdrop-blur-sm select-none">
      <div className="w-[420px] max-w-[90%] flex flex-col items-center gap-3 rounded-lg border border-subtle bg-surface-3 px-6 py-7 shadow-xl">
        {isConnecting ? (
          <CircleNotch size={32} className="text-muted animate-spin" />
        ) : (
          <CloudWarning size={32} weight="fill" className="text-red-400" />
        )}

        <div className="text-center">
          <div className="text-[15px] font-semibold text-primary">
            {isConnecting ? 'Connecting to companion' : 'Companion not available'}
          </div>
          {label && <div className="mt-0.5 text-[12px] text-muted">{label}</div>}
        </div>

        <div className="w-full text-center text-[12px] text-secondary whitespace-pre-wrap break-words max-h-32 overflow-auto rounded bg-surface-2 border border-subtle px-3 py-2">
          {reason}
        </div>

        <button
          className={`px-3 py-1.5 rounded text-[13px] mt-1 ${
            isConnecting
              ? 'bg-surface-2 text-muted cursor-default'
              : 'bg-focus-blue text-white hover:opacity-90'
          }`}
          onClick={handleInstall}
          disabled={isConnecting}
        >
          {isConnecting ? 'Installing…' : 'Install Companion'}
        </button>
      </div>
    </div>
  )
}
