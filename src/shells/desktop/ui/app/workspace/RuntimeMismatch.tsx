// The workspace's card for a runtime of another version (7.10). The client
// core runs the update (`RuntimeUpdates`: updating an unused runtime without
// asking, the update itself, its progress and the restart); this card draws
// it: the question when the runtime is older and in use (updating ends its
// terminals and running agents), "update Cate" when the runtime is newer,
// and the update's progress until the runtime answers again.
//
// It is the incompatible workspace's ConnectionBlocker card: it covers that
// workspace only, never the app (the sidebar and other workspaces stay
// usable).

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, ArrowRight, Folder, RefreshCw } from 'lucide-react'
import { ModalCard, ProgressBar, btn, Spinner } from '../../kernel/interaction'
import { runtimeMismatch, type RuntimeMismatch, type RuntimeUpdateRun, type WorkspaceConnection } from '@client/connections'
import { useConnectionState } from '../../client/connections'
import { tryClientApp } from '../app'
import { runWindowAction } from '../actions/run'

const noop = () => () => {}

/** The update this client runs on `connection`, if any. */
export function useRuntimeUpdate(connection: WorkspaceConnection | undefined): RuntimeUpdateRun | null {
  const updates = tryClientApp()?.runtimeUpdates
  return useSyncExternalStore(updates?.subscribe ?? noop, () => (connection && updates ? updates.run(connection) : null))
}

/** The core decides whether this workspace requires an update. */
export function useRequiredRuntimeUpdate(connection: WorkspaceConnection | undefined): RuntimeMismatch | null {
  const state = useConnectionState(connection)
  const app = tryClientApp()
  const updates = app?.runtimeUpdates
  const required = useSyncExternalStore(updates?.subscribe ?? noop, () => (connection && updates ? updates.required(connection) : null))
  return required ?? runtimeMismatch(state, app?.version ?? '')
}

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1)

/** The card while an update runs: what it does, and a bar. */
function UpdateProgressCard({ run }: { run: RuntimeUpdateRun }): JSX.Element {
  const progress = run.phase === 'installing' ? run.progress : null
  // One bar over the whole update, only ever moving forward: the download
  // fills most of it, install and restart the rest.
  const fraction = run.phase === 'restarting'
    ? 0.95
    : progress?.phase === 'install'
      ? 0.85
      : progress?.phase === 'download' && progress.total ? 0.8 * Math.min(1, progress.received / progress.total) : 0
  const label = run.phase === 'restarting'
    ? 'Reopening the workspace'
    : progress?.phase === 'download'
      ? `Downloading workspace update`
      : progress?.phase === 'install' ? 'Installing workspace update' : 'Updating the workspace'
  const detail = progress?.phase === 'download'
    ? (progress.total ? `${mb(progress.received)} of ${mb(progress.total)} MB` : `${mb(progress.received)} MB`)
    : run.phase === 'restarting' ? 'The workspace reconnects when it is back.' : null
  return (
    <ModalCard className="w-[360px] max-w-[92%]" bodyClassName="px-5 py-4">
      <div role="status" className="flex flex-col gap-2.5">
        <p className="flex items-center gap-2 text-[13px] text-primary">
          <Spinner size={13} />
          {label}
        </p>
        <ProgressBar value={fraction} label={label} />
        {detail && <p className="text-[12px] text-muted">{detail}</p>}
      </div>
    </ModalCard>
  )
}

export function RuntimeMismatchCard({ connection }: { connection: WorkspaceConnection }): JSX.Element | null {
  const run = useRuntimeUpdate(connection)
  const mismatch = useRequiredRuntimeUpdate(connection)
  const app = tryClientApp()
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  // Set on every mount: StrictMode unmounts and remounts once in dev.
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const version = app?.version ?? ''
  if (run) return <UpdateProgressCard run={run} />
  if (!mismatch || !app) return null
  const name = app.workspaces.get(connection.workspaceId)?.name ?? connection.workspaceId
  const icon = <AlertTriangle size={16} className="text-warning" />
  const updateApp = mismatch.update === 'app'

  const confirm = async () => {
    setError(null)
    const failed = await app.runtimeUpdates.update(connection)
    if (failed && mounted.current) setError(failed)
  }

  return (
    <ModalCard
      className="w-[360px] max-w-[92%]"
      icon={updateApp ? icon : <RefreshCw size={16} />}
      title={updateApp ? 'Update Cate' : 'Workspace update ready'}
      showClose={false}
      bodyClassName="min-h-0 overflow-auto"
    >
      <div className="space-y-3 px-5 py-4">
        <div className="flex items-center gap-3 rounded-lg border border-subtle bg-surface-0/40 px-3 py-2.5">
          <Folder size={18} className="shrink-0 text-secondary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="break-words text-[13px] font-medium text-primary">{name}</p>
            <div className="mt-1 flex items-center gap-2 text-[11px]">
              <span className="min-w-0 break-all font-mono text-muted"><span className="sr-only">Current version: </span>{updateApp ? version : mismatch.runtimeVersion}</span>
              <ArrowRight size={12} className="shrink-0 text-muted" aria-hidden="true" />
              <span className="min-w-0 break-all font-mono text-primary"><span className="sr-only">Update version: </span>{updateApp ? mismatch.runtimeVersion : version}</span>
            </div>
          </div>
        </div>

        {updateApp ? <p className="text-[12px] leading-relaxed text-secondary">Update Cate to open this workspace.</p> : <div className="flex items-start gap-2.5 text-[12px] leading-relaxed text-secondary">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <p>Stops terminals and agents for everyone.</p>
        </div>}

        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      </div>

      <div className="flex justify-end border-t border-subtle bg-surface-0/40 px-5 py-3">
        <button type="button" className={btn.primary} onClick={() => updateApp ? runWindowAction('checkForUpdates') : void confirm()}>
          {updateApp ? 'Check for Updates…' : 'Update and Stop Work…'}
        </button>
      </div>
    </ModalCard>
  )
}
