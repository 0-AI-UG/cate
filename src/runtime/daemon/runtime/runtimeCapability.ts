import { RpcError } from '@kernel/rpc/contract'
import type { CapabilityImpl, RpcServer } from '@kernel/rpc/runtime'
import type { RuntimeStatus, runtimeCapability } from '../contract'
import type { PerfSampler } from './perf'

export interface RuntimeCapabilityDeps {
  runtimeId: string
  root: string
  version: string
  rpc: RpcServer
  perf: PerfSampler
  /** Stops the runtime after the reply is sent. */
  stop: () => void
  /** Installs `version`; the runtime then restarts into it. */
  update: (version: string) => Promise<void>
}

export function runtimeCapabilityImpl(deps: RuntimeCapabilityDeps): CapabilityImpl<typeof runtimeCapability> {
  // Let the reply leave before the socket closes.
  const later = (fn: () => void) => { setTimeout(fn, 20) }
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
    async update({ version }) {
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(version)) {
        throw new RpcError('rejected', `invalid version ${String(version)}`)
      }
      if (version === deps.version) return
      await deps.update(version)
    },
    perf: () => deps.perf.sample(),
  }
}
