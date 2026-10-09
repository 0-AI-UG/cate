// The question an incompatible workspace runtime raises (7.10): another
// protocol major than this app. Every call fails until the runtime is
// updated, which ends its
// terminals and agents. When nothing else uses the runtime (no other client,
// no running work) the update happens without asking; otherwise the card
// asks first. It cannot list the work: an incompatible runtime answers only
// `runtime.info` and `runtime.update`. A runtime newer than this app is never
// moved back; the card asks to update the app instead.
//
// It is the incompatible workspace's ConnectionBlocker card: it covers that
// workspace only, never the app (the sidebar and other workspaces stay
// usable). An update in flight outlives the card's state: it shows the
// download and install, then holds the card through the restart until the
// new runtime answers, instead of a "can't connect" cover.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle } from 'lucide-react'
import { ModalCard, btn, Spinner } from '../../kernel/interaction'
import { errorMessage } from '@kernel/interaction'
import { compareSemver, type RuntimeUpdateProgress } from '@runtime/daemon/contract'
import type { WorkspaceConnection } from '@client/connections'
import { useConnectionState } from '../../client/connections'
import { tryClientApp } from '../app'

/** How long a restarting runtime may take to drop the connection. */
const RESTART_TIMEOUT_MS = 10_000
/** How long the restarted runtime may take to answer again. */
const RECONNECT_TIMEOUT_MS = 60_000
const PROGRESS_POLL_MS = 250

/** Resolves true once `done(state)` holds, false after `ms`. */
function waitFor(connection: WorkspaceConnection, done: (kind: string) => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ok: boolean) => { clearTimeout(timer); off(); resolve(ok) }
    const timer = setTimeout(() => finish(false), ms)
    const off = connection.subscribe(() => { if (done(connection.state.kind)) finish(true) })
    if (done(connection.state.kind)) finish(true)
  })
}

/** An update this client runs: installing (with the runtime's progress, null
 *  until it reports one), then restarting until the connection is back. */
export type RuntimeUpdateRun =
  | { phase: 'installing'; progress: RuntimeUpdateProgress | null }
  | { phase: 'restarting' }

const runs = new Map<WorkspaceConnection, RuntimeUpdateRun>()
const runListeners = new Set<() => void>()
const subscribeRuns = (listener: () => void) => { runListeners.add(listener); return () => { runListeners.delete(listener) } }
function setRun(connection: WorkspaceConnection, run: RuntimeUpdateRun | null): void {
  if (run) runs.set(connection, run)
  else runs.delete(connection)
  for (const listener of [...runListeners]) listener()
}

/** The update this client runs on `connection`, if any. */
export function useRuntimeUpdate(connection: WorkspaceConnection | undefined): RuntimeUpdateRun | null {
  return useSyncExternalStore(subscribeRuns, () => (connection ? runs.get(connection) ?? null : null))
}

/**
 * Updates the runtime and waits until it answers again. Resolves null once
 * connected, else why not. Meanwhile `useRuntimeUpdate` tells the phase.
 */
async function runUpdate(connection: WorkspaceConnection, target: { version: string; build?: string; ifIdle?: boolean }): Promise<string | null> {
  if (runs.has(connection)) return 'An update is already running.'
  const api = connection.runtime.runtime
  setRun(connection, { phase: 'installing', progress: null })
  // A runtime without `updateProgress` (older) just shows no figures.
  const poll = setInterval(() => {
    api.updateProgress().then(
      (progress) => { if (runs.get(connection)?.phase === 'installing') setRun(connection, { phase: 'installing', progress }) },
      () => clearInterval(poll),
    )
  }, PROGRESS_POLL_MS)
  try {
    await api.update(target)
  } catch (err) {
    setRun(connection, null)
    return errorMessage(err, 'The runtime did not answer.')
  } finally {
    clearInterval(poll)
  }
  setRun(connection, { phase: 'restarting' })
  if (!await waitFor(connection, (kind) => kind !== 'incompatible', RESTART_TIMEOUT_MS)) {
    setRun(connection, null)
    const pid = await api.info().then((info) => info.pid, () => null)
    return pid
      ? `The runtime did not restart. Stop it (process ${pid}) and open the workspace again.`
      : 'The runtime did not restart. Stop it and open the workspace again.'
  }
  const settled = (kind: string) => kind === 'connected' || kind === 'incompatible' || kind === 'refused' || kind === 'stopped' || kind === 'closed'
  await waitFor(connection, settled, RECONNECT_TIMEOUT_MS)
  setRun(connection, null)
  if (connection.state.kind === 'incompatible') return 'The runtime restarted but still does not match this app.'
  return null
}

/** Connections whose idle update was tried in their current incompatible
 *  episode (the card remounts when the workspace is shown again). */
const triedIdle = new Set<WorkspaceConnection>()

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
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)}
          className="relative h-1.5 overflow-hidden rounded-full bg-surface-5"
        >
          <div className="h-full rounded-full bg-focus-blue transition-[width] duration-300" style={{ width: `${fraction * 100}%` }} />
        </div>
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
  const [idleTry, setIdleTry] = useState(() => !triedIdle.has(connection) && !runs.has(connection))
  const mounted = useRef(true)
  // Set on every mount: StrictMode unmounts and remounts once in dev.
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const incompatible = state.kind === 'incompatible' ? state : null
  const version = app?.version ?? ''
  const target = incompatible ? { version, ...(app?.build ? { build: app.build } : {}) } : null
  // Never move a runtime back to an older release (another device may need it).
  const newer = incompatible !== null && compareSemver(incompatible.runtimeVersion, version) > 0

  // A connection that left the state asks again next time.
  useEffect(() => {
    if (state.kind !== 'incompatible') triedIdle.delete(connection)
  }, [state.kind, connection])

  // Nothing else uses the runtime: update it without asking.
  useEffect(() => {
    if (!idleTry || !target || newer) {
      setIdleTry(false)
      return
    }
    triedIdle.add(connection)
    void runUpdate(connection, { ...target, ifIdle: true }).then(() => { if (mounted.current) setIdleTry(false) })
    // Once per mount; `triedIdle` keeps it once per incompatible episode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (run) return <UpdateProgressCard run={run} version={version} />
  if (!incompatible || !app || !target) return null
  const name = app.workspaces.get(connection.workspaceId)?.name ?? connection.workspaceId
  const icon = <AlertTriangle size={16} className="text-amber-400" />

  // The idle try is refused at once when something uses the runtime; until
  // then show nothing to decide.
  if (idleTry) return <UpdateProgressCard run={{ phase: 'installing', progress: null }} version={version} />

  if (newer) {
    return (
      <ModalCard className="w-[440px] max-w-[92%]" icon={icon} title="Update Cate to use this workspace" showClose={false} bodyClassName="px-5 py-4">
        <p className="text-[13px] leading-relaxed text-secondary">
          <span className="text-primary font-medium">{name}</span>
          {` runs Cate runtime ${incompatible.runtimeVersion}, which is newer than this app (${version}). Update Cate to use the workspace.`}
        </p>
      </ModalCard>
    )
  }

  const confirm = async () => {
    setError(null)
    const failed = await runUpdate(connection, target)
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
        {` runs Cate runtime ${incompatible.runtimeVersion}, which this app can't talk to. Update it to ${version} to use the workspace.`}
      </p>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-2.5 py-2 rounded-md bg-surface-5 border border-subtle text-[12px]">
        <dt className="text-muted">This app</dt>
        <dd className="font-mono text-secondary break-all">{version}</dd>
        <dt className="text-muted">Runtime</dt>
        <dd className="font-mono text-secondary break-all">{incompatible.runtimeVersion}</dd>
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
