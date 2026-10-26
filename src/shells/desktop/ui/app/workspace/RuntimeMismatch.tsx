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
import { AlertTriangle } from 'lucide-react'
import { ModalCard, ProgressBar, btn, Spinner } from '../../kernel/interaction'
import { runtimeMismatch, type RuntimeUpdateRun, type WorkspaceConnection } from '@client/connections'
import { useConnectionState } from '../../client/connections'
import { tryClientApp } from '../app'
import { runWindowAction } from '../actions/run'

const noop = () => () => {}

/** The update this client runs on `connection`, if any. */
export function useRuntimeUpdate(connection: WorkspaceConnection | undefined): RuntimeUpdateRun | null {
  const updates = tryClientApp()?.runtimeUpdates
  return useSyncExternalStore(updates?.subscribe ?? noop, () => (connection && updates ? updates.run(connection) : null))
}

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1)

/** The card while an update runs: what it does, and a bar. */
function UpdateProgressCard({ run, version }: { run: RuntimeUpdateRun; version: string }): JSX.Element {
  const progress = run.phase === 'installing' ? run.progress : null
  // One bar over the whole update, only ever moving forward: the download
  // fills most of it, install and restart the rest.
  const fraction = run.phase === 'restarting'
    ? 0.95
    : progress?.phase === 'install'
      ? 0.85
      : progress?.phase === 'download' && progress.total ? 0.8 * Math.min(1, progress.received / progress.total) : 0
  const label = run.phase === 'restarting'
    ? 'Restarting the workspace runtime'
    : progress?.phase === 'download'
      ? `Downloading Cate runtime ${version}`
      : progress?.phase === 'install' ? 'Installing the workspace runtime' : 'Updating the workspace runtime'
  const detail = progress?.phase === 'download'
    ? (progress.total ? `${mb(progress.received)} of ${mb(progress.total)} MB` : `${mb(progress.received)} MB`)
    : run.phase === 'restarting' ? 'The workspace reconnects when it is back.' : null
  return (
    <ModalCard className="w-[440px] max-w-[92%]" bodyClassName="px-5 py-4">
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
  const state = useConnectionState(connection)
  const run = useRuntimeUpdate(connection)
  const app = tryClientApp()
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  // Set on every mount: StrictMode unmounts and remounts once in dev.
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const version = app?.version ?? ''
  if (run) return <UpdateProgressCard run={run} version={version} />
  const mismatch = runtimeMismatch(state, version)
  if (!mismatch || !app) return null
  const name = app.workspaces.get(connection.workspaceId)?.name ?? connection.workspaceId
  const icon = <AlertTriangle size={16} className="text-amber-400" />

  if (mismatch.update === 'app') {
    return (
      <ModalCard className="w-[440px] max-w-[92%]" icon={icon} title="Update Cate to use this workspace" showClose={false} bodyClassName="px-5 py-4">
        <p className="text-[13px] leading-relaxed text-secondary">
          <span className="text-primary font-medium">{name}</span>
          {` runs Cate runtime ${mismatch.runtimeVersion}, which is newer than this app (${version}). Update Cate to use the workspace.`}
        </p>
        <div className="mt-4 flex justify-end">
          <button type="button" className={btn.primary} onClick={() => runWindowAction('checkForUpdates')}>Check for Updates…</button>
        </div>
      </ModalCard>
    )
  }

  const confirm = async () => {
    setError(null)
    const failed = await app.runtimeUpdates.update(connection)
    if (failed && mounted.current) setError(failed)
  }

  return (
    <ModalCard
      className="w-[440px] max-w-[92%]"
      icon={icon}
      title="Workspace runtime needs an update"
      showClose={false}
      bodyClassName="px-5 py-4"
    >
      <p className="text-[13px] leading-relaxed text-secondary">
        <span className="text-primary font-medium">{name}</span>
        {` runs Cate runtime ${mismatch.runtimeVersion}, which this app can't talk to. Update it to ${version} to use the workspace.`}
      </p>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-2.5 py-2 rounded-md bg-surface-5 border border-subtle text-[12px]">
        <dt className="text-muted">This app</dt>
        <dd className="font-mono text-secondary break-all">{version}</dd>
        <dt className="text-muted">Runtime</dt>
        <dd className="font-mono text-secondary break-all">{mismatch.runtimeVersion}</dd>
      </dl>

      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        Updating ends the workspace's terminals and running agents for everyone connected to it.
      </p>

      {error && <p className="mt-3 text-[12px] text-danger">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={btn.primary} onClick={() => void confirm()}>
          {`Update to ${version}`}
        </button>
      </div>
    </ModalCard>
  )
}
