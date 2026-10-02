// The question an incompatible workspace runtime raises (7.10): another
// protocol major, or another build than this app (a stale runtime). Every
// call fails until the runtime is updated or restarted, which ends its
// terminals and agents. When nothing else uses the runtime (no other client,
// no running work) the update happens without asking; otherwise the dialog
// asks first. It cannot list the work: an incompatible runtime answers only
// `runtime.info` and `runtime.update`. A runtime newer than this app is never
// moved back; the dialog asks to update the app instead.
//
// One dialog at a time, for the first incompatible connection. "Not now"
// hides it for that connection until its state changes; the sidebar dot
// opens it again (`showRuntimeMismatch`).

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Modal, Spinner, btn, errorMessage } from '@kernel/ui'
import { compareSemver } from '@runtime/daemon/contract'
import type { WorkspaceConnection, WorkspaceConnections } from '@client/connections'
import { useConnectionState } from '@client/connections/ui'
import { tryClientApp } from '../app'

/** How long a restarting runtime may take to drop the connection. */
const RESTART_TIMEOUT_MS = 10_000

/** Resolves true once the connection leaves `incompatible`, false after `ms`. */
function dropsWithin(connection: WorkspaceConnection, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (dropped: boolean) => { clearTimeout(timer); off(); resolve(dropped) }
    const timer = setTimeout(() => done(false), ms)
    const off = connection.subscribe(() => { if (connection.state.kind !== 'incompatible') done(true) })
    if (connection.state.kind !== 'incompatible') done(true)
  })
}

const dismissed = new Set<WorkspaceConnection>()
/** Connections whose idle update was tried in their current incompatible
 *  episode. */
const triedIdle = new Set<WorkspaceConnection>()
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of [...listeners]) listener()
}

/** Opens the dialog for `connection` again after "Not now". */
export function showRuntimeMismatch(connection: WorkspaceConnection): void {
  if (dismissed.delete(connection)) changed()
}

function dismiss(connection: WorkspaceConnection): void {
  dismissed.add(connection)
  changed()
}

function useIncompatibleConnection(connections: WorkspaceConnections): WorkspaceConnection | null {
  return useSyncExternalStore(
    (listener) => {
      const offs = new Map<WorkspaceConnection, () => void>()
      const sync = () => {
        const current = new Set(connections.getSnapshot())
        for (const [connection, off] of offs) if (!current.has(connection)) { off(); offs.delete(connection) }
        for (const connection of current) if (!offs.has(connection)) offs.set(connection, connection.subscribe(listener))
        listener()
      }
      const offList = connections.subscribe(sync)
      listeners.add(listener)
      sync()
      return () => {
        offList()
        listeners.delete(listener)
        for (const off of offs.values()) off()
      }
    },
    () => {
      // A connection that left the state asks again next time.
      for (const connection of dismissed) if (connection.state.kind !== 'incompatible') dismissed.delete(connection)
      for (const connection of triedIdle) if (connection.state.kind !== 'incompatible') triedIdle.delete(connection)
      return connections.getSnapshot().find((c) => c.state.kind === 'incompatible' && !dismissed.has(c)) ?? null
    },
  )
}

export function RuntimeMismatchDialog(): JSX.Element | null {
  const app = tryClientApp()
  return app ? <RuntimeMismatchDialogFor connections={app.connections} /> : null
}

function RuntimeMismatchDialogFor({ connections }: { connections: WorkspaceConnections }): JSX.Element | null {
  const connection = useIncompatibleConnection(connections)
  return connection ? <MismatchDialog key={connection.workspaceId} connection={connection} /> : null
}

function MismatchDialog({ connection }: { connection: WorkspaceConnection }): JSX.Element | null {
  const state = useConnectionState(connection)
  const app = tryClientApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [idleTry, setIdleTry] = useState(() => !triedIdle.has(connection))
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const incompatible = state.kind === 'incompatible' ? state : null
  const version = app?.version ?? ''
  const target = incompatible ? { version, ...(incompatible.build ? { build: incompatible.build.app } : {}) } : null
  // Never move a runtime back to an older release (another device may need it).
  const newer = incompatible !== null && compareSemver(incompatible.runtimeVersion, version) > 0

  // Nothing else uses the runtime: update it without asking.
  useEffect(() => {
    if (!idleTry || !target || newer) {
      setIdleTry(false)
      return
    }
    triedIdle.add(connection)
    void connection.runtime.runtime.update({ ...target, ifIdle: true })
      .then(() => dropsWithin(connection, RESTART_TIMEOUT_MS), () => false)
      .then((dropped) => { if (!dropped && mounted.current) setIdleTry(false) })
    // Once per mount; `triedIdle` keeps it once per incompatible episode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!incompatible || !app || !target || idleTry) return null
  const name = app.workspaces.get(connection.workspaceId)?.name ?? connection.workspaceId
  // Same version, other build: a stale runtime that a restart replaces.
  const restart = incompatible.runtimeVersion === version

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await connection.runtime.runtime.update(target)
    } catch (err) {
      setError(errorMessage(err, 'The runtime did not answer.'))
      setBusy(false)
      return
    }
    // A restart drops the connection, which closes this dialog.
    if (await dropsWithin(connection, RESTART_TIMEOUT_MS)) return
    const pid = await connection.runtime.runtime.info().then((info) => info.pid, () => null)
    if (!mounted.current) return
    setError(pid
      ? `The runtime did not restart. Stop it (process ${pid}) and open the workspace again.`
      : 'The runtime did not restart. Stop it and open the workspace again.')
    setBusy(false)
  }

  if (newer) {
    return (
      <Modal
        onClose={() => dismiss(connection)}
        width={440}
        icon={<AlertTriangle size={16} className="text-amber-400" />}
        title="Update Cate to use this workspace"
        bodyClassName="px-5 py-4"
      >
        <p className="text-[13px] leading-relaxed text-secondary">
          <span className="text-primary font-medium">{name}</span>
          {` runs Cate runtime ${incompatible.runtimeVersion}, which is newer than this app (${version}). Update Cate to use the workspace.`}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={btn.primary} onClick={() => dismiss(connection)} autoFocus>
            OK
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      onClose={() => dismiss(connection)}
      width={440}
      icon={<AlertTriangle size={16} className="text-amber-400" />}
      title={restart ? 'Workspace runtime is out of date' : 'Workspace runtime needs an update'}
      dismissable={!busy}
      bodyClassName="px-5 py-4"
    >
      <p className="text-[13px] leading-relaxed text-secondary">
        <span className="text-primary font-medium">{name}</span>
        {restart
          ? ' runs a different build of the Cate runtime than this app. Cate can\'t use it until it restarts.'
          : ` runs Cate runtime ${incompatible.runtimeVersion}, which this app can't talk to. Update it to ${version} to use the workspace.`}
      </p>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-2.5 py-2 rounded-md bg-surface-5 border border-subtle text-[12px]">
        <dt className="text-muted">This app</dt>
        <dd className="font-mono text-secondary break-all">{incompatible.build?.app ?? version}</dd>
        <dt className="text-muted">Runtime</dt>
        <dd className="font-mono text-secondary break-all">{incompatible.build ? (incompatible.build.runtime ?? `${incompatible.runtimeVersion} (no build)`) : incompatible.runtimeVersion}</dd>
      </dl>

      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        {restart ? 'Restarting' : 'Updating'} ends the workspace's terminals and running agents for everyone connected to it.
      </p>

      {error && <p className="mt-3 text-[12px] text-danger">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={() => dismiss(connection)} disabled={busy} autoFocus>
          Not now
        </button>
        <button type="button" className={btn.primary} onClick={() => void confirm()} disabled={busy}>
          {busy && <Spinner size={13} />}
          {busy ? (restart ? 'Restarting' : 'Updating') : (restart ? 'Restart runtime' : `Update to ${version}`)}
        </button>
      </div>
    </Modal>
  )
}
