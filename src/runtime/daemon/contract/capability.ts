// The `runtime` host capability (architecture 7.9, 7.10).

import { defineCapability, method, type ClientFeature, type DeviceInfo, type ProtocolVersion } from '@kernel/rpc/contract'

export interface RuntimeClientInfo {
  clientId: string
  device: DeviceInfo
  features: ClientFeature[]
}

export interface RuntimeStatus {
  runtimeId: string
  root: string
  version: string
  protocol: ProtocolVersion
  pid: number
  clients: RuntimeClientInfo[]
}

export interface RuntimePerfSample {
  pid: number
  platform: string
  windowMs: number
  /** Percent of one core over the window. */
  cpu: number
  rssMB: number
  eventLoop: { p95Ms: number; maxMs: number }
  /** Per-name rates contributed by modules (process scans, spawns). */
  counters: Record<string, number>
}

export const runtimeCapability = defineCapability('runtime', {
  methods: {
    /** Answered on every protocol major, so a client can tell what it talks to. */
    info: method<void, RuntimeStatus>({ crossMajor: true }),
    /** Stops the runtime and everything it runs. */
    stop: method<void, void>({ mutates: true }),
    /** Restarts into the install of `build` (the client's), or of release
     *  `version` downloaded from GitHub Releases when that build is not on
     *  this machine; a release of another build is refused. Also for its own
     *  version (a stale build). With `ifIdle`, fails `dirty` while other
     *  clients are connected or work runs. Crosses majors so an incompatible
     *  runtime can still be brought in line. */
    update: method<{ version: string; build?: string; ifIdle?: boolean }, void>({ mutates: true, crossMajor: true, timeoutMs: 0 }),
    /** The first call starts sampling and returns an empty window. */
    perf: method<void, RuntimePerfSample>(),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    runtime: typeof runtimeCapability
  }
}
