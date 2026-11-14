import { RpcError } from '@kernel/rpc/contract'
import type { CapabilityImpl, RpcServer } from '@kernel/rpc/runtime'
import { buildVersion, compareSemver, isBuildId, type RuntimeStatus, type RuntimeStopReason, type RuntimeUpdateProgress, type runtimeCapability } from '../contract'
import type { NetworkEndpoint } from '@runtime/transports/contract'
import type { PerfSampler } from './perf'

export interface RuntimeCapabilityDeps {
  runtimeId: string
  root: string
  /** The machine's name, shown to paired devices. */
  machineName: string
  /** The machine sleeps on its own. */
  machineSleeps: boolean
  version: string
  rpc: RpcServer
  perf: PerfSampler
  /** Where paired devices reach the runtime now. */
  endpoints: () => NetworkEndpoint[]
  /** Work is running (busy terminals, agents). */
  busy: () => boolean
  /** Stops the runtime after the reply is sent. */
  stop: () => void
  /** Runs `listener` when the runtime starts stopping, before connections close. */
  onStopping: (listener: (reason: RuntimeStopReason) => void) => () => void
  /** Prepares the install, then returns the action committing the restart.
   *  Idle-only updates recheck safety after the asynchronous preparation. */
  prepareUpdate: (target: { version: string; build?: string }, onProgress: (progress: RuntimeUpdateProgress) => void) => Promise<() => void>
}

interface Updating {
  key: string
  done: Promise<void>
  progress: RuntimeUpdateProgress | null
}

export function runtimeCapabilityImpl(deps: RuntimeCapabilityDeps): CapabilityImpl<typeof runtimeCapability> {
  // Let the reply leave before the socket closes.
  const later = (fn: () => void) => { setTimeout(fn, 20) }
  let updating: Updating | null = null
  return {
    info: (): RuntimeStatus => ({
      runtimeId: deps.runtimeId,
      root: deps.root,
      machineName: deps.machineName,
      machineSleeps: deps.machineSleeps,
      version: deps.version,
      pid: process.pid,
      clients: deps.rpc.connections().flatMap((c) =>
        c.client ? [{ clientId: c.client.clientId, device: { ...c.client.device }, features: [...c.client.features] }] : []),
      endpoints: deps.endpoints(),
    }),
    stop: () => later(deps.stop),
    async update({ version, build, ifIdle }, ctx) {
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(version)) {
        throw new RpcError('rejected', `invalid version ${String(version)}`)
      }
      // Never back to an older release (another device may need this one).
      if (compareSemver(version, deps.version) < 0) {
        throw new RpcError('rejected', `${version} is older than the running ${deps.version}`)
      }
      if (build !== undefined && (typeof build !== 'string' || !isBuildId(build) || buildVersion(build) !== version)) {
        throw new RpcError('rejected', `invalid build ${String(build)} for version ${version}`)
      }
      const assertIdle = () => {
        // An incompatible client cannot use the runtime: it uses nothing.
        const others = deps.rpc.connections().some((c) => c.client !== null && c.compatible && c.id !== ctx.connection.id)
        if (others) throw new RpcError('dirty', 'the runtime has other clients', { reason: 'shared' })
        if (deps.busy()) throw new RpcError('dirty', 'the runtime has running work', { reason: 'busy' })
      }
      if (ifIdle) assertIdle()
      // One update at a time; a second caller for the same target waits on it.
      const key = build ?? version
      if (updating && updating.key !== key) throw new RpcError('conflict', `already updating to ${updating.key}`)
      if (!updating) {
        const current: Updating = { key, done: Promise.resolve(), progress: null }
        updating = current
        current.done = (async () => {
          const restart = await deps.prepareUpdate({ version, ...(build ? { build } : {}) }, (progress) => { current.progress = progress })
          if (ifIdle) assertIdle()
          restart()
        })()
        current.done.catch(() => { if (updating === current) updating = null })
      }
      // The same version restarts too: a stale build of it is replaced by the
      // install of the client's build.
      await updating.done
    },
    updateProgress: () => updating?.progress ?? null,
    perf: () => deps.perf.sample(),
    lifecycle: (_params, sink) => deps.onStopping((reason) => sink.emit({ kind: 'stopping', reason })),
  }
}
