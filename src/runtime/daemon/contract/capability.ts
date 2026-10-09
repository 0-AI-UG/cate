// The `runtime` host capability (architecture 7.9, 7.10).

import { defineCapability, method, stream, type ClientFeature, type DeviceInfo, type ProtocolVersion } from '@kernel/rpc/contract'
import type { NetworkEndpoint } from '@runtime/transports/contract'

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
  /** Where paired devices reach it now (its addresses change with the
   *  network); empty with network access off. Absent from older runtimes. */
  endpoints?: NetworkEndpoint[]
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

/** A runtime update before its restart: downloading the release (`total`
 *  null when the server does not say), then extracting it. */
export type RuntimeUpdateProgress =
  | { phase: 'download'; received: number; total: number | null }
  | { phase: 'install' }

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
    /** Where the running `update` is (null: none), for a progress bar. */
    updateProgress: method<void, RuntimeUpdateProgress | null>({ crossMajor: true }),
    /** The first call starts sampling and returns an empty window. */
    perf: method<void, RuntimePerfSample>(),
  },
  streams: {
    /** Told before the runtime goes away and why, so clients can tell a
     *  deliberate stop (stay stopped) from a crash or update (reconnect). */
    lifecycle: stream<void, RuntimeLifecycleEvent>(),
  },
})

export type RuntimeStopReason = 'stop' | 'update' | 'idle' | 'signal'

export type RuntimeLifecycleEvent = { kind: 'stopping'; reason: RuntimeStopReason }

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    runtime: typeof runtimeCapability
  }
}
