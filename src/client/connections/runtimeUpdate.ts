// Bring older runtimes to this client's release, including compatible ones.
// Try once per connection while idle. Compatible shared runtimes stay usable;
// a sole busy client asks before stopping work. Incompatibility always blocks.

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

/** A protocol mismatch that prevents using the workspace. */
export function runtimeMismatch(state: ConnectionState, appVersion: string): RuntimeMismatch | null {
  if (state.kind !== 'incompatible') return null
  const newer = compareSemver(state.runtimeVersion, appVersion) > 0
  return { update: newer ? 'app' : 'runtime', runtimeVersion: state.runtimeVersion, appVersion }
}

/** Older compatible releases are candidates for an idle update, not blockers. */
function updateCandidate(state: ConnectionState, appVersion: string): RuntimeMismatch | null {
  if (state.kind === 'connected' && state.runtimeVersion && compareSemver(state.runtimeVersion, appVersion) < 0) {
    return { update: 'runtime', runtimeVersion: state.runtimeVersion, appVersion }
  }
  return runtimeMismatch(state, appVersion)
}

/** One availability rule for every shell, including a confirmed restart. */
export function connectionUsable(state: ConnectionState, required: RuntimeMismatch | null, updating: boolean): boolean {
  return state.kind === 'connected' && required === null && !updating
}

/** An update this client runs: installing (with the runtime's progress, null
 *  until it reports one), then restarting until the connection is back. */
export type RuntimeUpdateRun =
  | { phase: 'installing'; progress: RuntimeUpdateProgress | null }
  | { phase: 'restarting' }

export interface RuntimeUpdates {
  /** Required protocol repair, or a sole client's release update awaiting
   *  confirmation. Compatible shared releases never require an update. */
  required(connection: WorkspaceConnection): RuntimeMismatch | null
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
  const required = new Map<WorkspaceConnection, RuntimeMismatch>()
  const listeners = new Set<() => void>()
  const setRequired = (connection: WorkspaceConnection, mismatch: RuntimeMismatch | null): void => {
    if (mismatch) required.set(connection, mismatch)
    else required.delete(connection)
    for (const listener of [...listeners]) listener()
  }
  const setRun = (connection: WorkspaceConnection, run: RuntimeUpdateRun | null): void => {
    if (run) runs.set(connection, run)
    else runs.delete(connection)
    for (const listener of [...listeners]) listener()
  }

  const runUpdate = async (connection: WorkspaceConnection, ifIdle: boolean): Promise<string | null> => {
    if (runs.has(connection)) return 'An update is already running.'
    const beforeRestart = connection.state
    const beforeEpoch = connection.rpc.remote?.epoch
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
    const settled = (kind: ConnectionState['kind']) => (kind === 'connected' || kind === 'incompatible')
      ? connection.rpc.remote?.epoch !== beforeEpoch
      : kind === 'refused' || kind === 'stopped' || kind === 'closed'
    const reconnected = await waitFor(connection, settled, RECONNECT_TIMEOUT_MS)
    setRun(connection, null)
    if (!reconnected || connection.state.kind !== 'connected') return 'The workspace did not reconnect after updating. Try connecting again.'
    if (connection.state.runtimeVersion && compareSemver(connection.state.runtimeVersion, deps.version) < 0) return 'The runtime restarted but still does not run this version.'
    if (connection.state.runtimeVersion === deps.version && deps.build && connection.rpc.remote?.build !== deps.build) return 'The runtime restarted but still does not run this build.'
    setRequired(connection, null)
    return null
  }

  // The idle try, once per outdated connection.
  const tried = new Set<WorkspaceConnection>()
  const watched = new Map<WorkspaceConnection, () => void>()
  const check = (connection: WorkspaceConnection): void => {
    const mismatch = updateCandidate(connection.state, deps.version)
    if (!mismatch) {
      setRequired(connection, null)
      tried.delete(connection)
      return
    }
    if (connection.state.kind === 'incompatible') setRequired(connection, mismatch)
    if (mismatch.update !== 'runtime' || tried.has(connection) || runs.has(connection)) return
    tried.add(connection)
    void runUpdate(connection, true).then(async (failed) => {
      if (!failed || connection.state.kind !== 'connected') return
      // The runtime's connected clients determine sharing, not the shell,
      // transport, saved pairings or an error's wording. This also keeps a
      // compatible shared workspace usable after an install/restart failure.
      const alone = await connection.runtime.runtime.info().then(
        (info) => info.clients.every((client) => client.clientId === connection.clientId),
        () => false,
      )
      const candidate = updateCandidate(connection.state, deps.version)
      if (alone && candidate) setRequired(connection, candidate)
    })
  }
  const sync = (): void => {
    const current = new Set(deps.connections.getSnapshot())
    for (const [connection, off] of watched) {
      if (current.has(connection)) continue
      off()
      watched.delete(connection)
      tried.delete(connection)
      required.delete(connection)
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
    required: (connection) => required.get(connection) ?? null,
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
