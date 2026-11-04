// Bring older runtimes to this client's release, including compatible ones.
// Try once per connection while idle; other clients or running work require
// confirmation because restarting ends terminals and agents for everyone.

import { compareSemver, type RuntimeUpdateProgress } from '@runtime/daemon/contract'
import type { ConnectionState, WorkspaceConnection } from './connection'
import type { WorkspaceConnections } from './registry'

/** How long a restarting runtime may take to drop the connection. */
const RESTART_TIMEOUT_MS = 10_000
/** How long the restarted runtime may take to answer again. */
const RECONNECT_TIMEOUT_MS = 60_000
const PROGRESS_POLL_MS = 250

/** Which side of a mismatch is updated: the runtime to this client's
 *  version, or this app to the runtime's. */
export interface RuntimeMismatch {
  update: 'runtime' | 'app'
  runtimeVersion: string
  appVersion: string
}

/** An incompatible runtime or a compatible runtime behind this client. */
export function runtimeMismatch(state: ConnectionState, appVersion: string): RuntimeMismatch | null {
  if (state.kind !== 'incompatible' && state.kind !== 'connected') return null
  if (!state.runtimeVersion) return null
  // Compatible newer runtimes stay usable; an older client never downgrades them.
  if (state.kind === 'connected' && compareSemver(state.runtimeVersion, appVersion) >= 0) return null
  const newer = compareSemver(state.runtimeVersion, appVersion) > 0
  return { update: newer ? 'app' : 'runtime', runtimeVersion: state.runtimeVersion, appVersion }
}

/** An update this client runs: installing (with the runtime's progress, null
 *  until it reports one), then restarting until the connection is back. */
export type RuntimeUpdateRun =
  | { phase: 'installing'; progress: RuntimeUpdateProgress | null }
  | { phase: 'restarting' }

export interface RuntimeUpdates {
  /** The update this client runs on `connection`, if any. */
  run(connection: WorkspaceConnection): RuntimeUpdateRun | null
  subscribe(listener: () => void): () => void
  /** Updates the runtime to this client's version and waits until it
   *  answers again. Resolves null once connected, else why not. */
  update(connection: WorkspaceConnection): Promise<string | null>
  dispose(): void
}

export interface RuntimeUpdatesDeps {
  connections: Pick<WorkspaceConnections, 'getSnapshot' | 'subscribe'>
  /** This client's version and build: what the runtime is updated to. */
  version: string
  build?: string
}

/** Resolves true once `done(state)` holds, false after `ms`. */
function waitFor(connection: WorkspaceConnection, done: (kind: ConnectionState['kind']) => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ok: boolean) => { clearTimeout(timer); off(); resolve(ok) }
    const timer = setTimeout(() => finish(false), ms)
    const off = connection.subscribe(() => { if (done(connection.state.kind)) finish(true) })
    if (done(connection.state.kind)) finish(true)
  })
}

export function createRuntimeUpdates(deps: RuntimeUpdatesDeps): RuntimeUpdates {
  const target = { version: deps.version, ...(deps.build ? { build: deps.build } : {}) }
  const runs = new Map<WorkspaceConnection, RuntimeUpdateRun>()
  const listeners = new Set<() => void>()
  const setRun = (connection: WorkspaceConnection, run: RuntimeUpdateRun | null): void => {
    if (run) runs.set(connection, run)
    else runs.delete(connection)
    for (const listener of [...listeners]) listener()
  }

  const runUpdate = async (connection: WorkspaceConnection, ifIdle: boolean): Promise<string | null> => {
    if (runs.has(connection)) return 'An update is already running.'
    const beforeRestart = connection.state
    const api = connection.runtime.runtime
    setRun(connection, { phase: 'installing', progress: null })
    const poll = setInterval(() => {
      api.updateProgress().then(
        (progress) => { if (runs.get(connection)?.phase === 'installing') setRun(connection, { phase: 'installing', progress }) },
        () => clearInterval(poll),
      )
    }, PROGRESS_POLL_MS)
    try {
      await api.update({ ...target, ...(ifIdle ? { ifIdle } : {}) })
    } catch (err) {
      setRun(connection, null)
      return err instanceof Error && err.message ? err.message : 'The runtime did not answer.'
    } finally {
      clearInterval(poll)
    }
    setRun(connection, { phase: 'restarting' })
    if (!await waitFor(connection, () => connection.state !== beforeRestart, RESTART_TIMEOUT_MS)) {
      setRun(connection, null)
      const pid = await api.info().then((info) => info.pid, () => null)
      return pid
        ? `The runtime did not restart. Stop it (process ${pid}) and open the workspace again.`
        : 'The runtime did not restart. Stop it and open the workspace again.'
    }
    const settled = (kind: ConnectionState['kind']) => kind === 'connected' || kind === 'incompatible' || kind === 'refused' || kind === 'stopped' || kind === 'closed'
    await waitFor(connection, settled, RECONNECT_TIMEOUT_MS)
    setRun(connection, null)
    if (runtimeMismatch(connection.state, deps.version)) return 'The runtime restarted but still does not run this version.'
    return null
  }

  // The idle try, once per outdated connection.
  const tried = new Set<WorkspaceConnection>()
  const watched = new Map<WorkspaceConnection, () => void>()
  const check = (connection: WorkspaceConnection): void => {
    const mismatch = runtimeMismatch(connection.state, deps.version)
    if (!mismatch) {
      tried.delete(connection)
      return
    }
    if (mismatch.update !== 'runtime' || tried.has(connection) || runs.has(connection)) return
    tried.add(connection)
    void runUpdate(connection, true)
  }
  const sync = (): void => {
    const current = new Set(deps.connections.getSnapshot())
    for (const [connection, off] of watched) {
      if (current.has(connection)) continue
      off()
      watched.delete(connection)
      tried.delete(connection)
    }
    for (const connection of current) {
      if (watched.has(connection)) continue
      watched.set(connection, connection.subscribe(() => check(connection)))
      check(connection)
    }
  }
  const stop = deps.connections.subscribe(sync)
  sync()

  return {
    run: (connection) => runs.get(connection) ?? null,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update: (connection) => runUpdate(connection, false),
    dispose() {
      stop()
      for (const off of watched.values()) off()
      watched.clear()
      listeners.clear()
    },
  }
}
