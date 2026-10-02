import { RpcError } from '@kernel/rpc/contract'
import type { CapabilityImpl, RpcServer } from '@kernel/rpc/runtime'
import { buildVersion, isBuildId, type RuntimeStatus, type runtimeCapability } from '../contract'
import type { PerfSampler } from './perf'

export interface RuntimeCapabilityDeps {
  runtimeId: string
  root: string
  version: string
  rpc: RpcServer
  perf: PerfSampler
  /** Work is running (busy terminals, agents, T3 turns). */
  busy: () => boolean
  /** Stops the runtime after the reply is sent. */
  stop: () => void
  /** Installs `build` (or release `version`) when missing; the runtime then
   *  restarts into it. */
  update: (target: { version: string; build?: string }) => Promise<void>
}

export function runtimeCapabilityImpl(deps: RuntimeCapabilityDeps): CapabilityImpl<typeof runtimeCapability> {
  // Let the reply leave before the socket closes.
  const later = (fn: () => void) => { setTimeout(fn, 20) }
  let updating: { key: string; done: Promise<void> } | null = null
  return {
    info: (): RuntimeStatus => ({
      runtimeId: deps.runtimeId,
      root: deps.root,
      version: deps.version,
      protocol: deps.rpc.protocol,
      pid: process.pid,
      clients: deps.rpc.connections().flatMap((c) =>
        c.client ? [{ clientId: c.client.clientId, device: { ...c.client.device }, features: [...c.client.features] }] : []),
    }),
    stop: () => later(deps.stop),
    async update({ version, build, ifIdle }, ctx) {
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(version)) {
        throw new RpcError('rejected', `invalid version ${String(version)}`)
      }
      if (build !== undefined && (typeof build !== 'string' || !isBuildId(build) || buildVersion(build) !== version)) {
        throw new RpcError('rejected', `invalid build ${String(build)} for version ${version}`)
      }
      if (ifIdle) {
        const others = deps.rpc.connections().some((c) => c.client !== null && c.id !== ctx.connection.id)
        if (others || deps.busy()) throw new RpcError('dirty', 'the runtime has other clients or running work')
      }
      // One update at a time; a second caller for the same target waits on it.
      const key = build ?? version
      if (updating && updating.key !== key) throw new RpcError('conflict', `already updating to ${updating.key}`)
      if (!updating) {
        const current = { key, done: deps.update({ version, ...(build ? { build } : {}) }) }
        updating = current
        current.done.catch(() => { if (updating === current) updating = null })
      }
      // The same version restarts too: a stale build of it is replaced by the
      // install of the client's build.
      await updating.done
    },
    perf: () => deps.perf.sample(),
  }
}
