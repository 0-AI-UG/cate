import { defineCapability, method, stream } from '@kernel/rpc/contract'

/** One trust decision per workspace (9.2), stored in `<data>/trust.json`.
 *  `decidedAt` is an ISO time, null before anyone decided. */
export interface TrustState {
  trusted: boolean
  decidedAt: string | null
}

export interface WorkspaceInfo {
  runtimeId: string
  /** Canonical workspace root on the runtime's machine. */
  root: string
  /** The root's folder name. */
  name: string
}

/** The workspace itself: trust and what it is. */
export const workspaceCapability = defineCapability('workspace', {
  methods: {
    info: method<void, WorkspaceInfo>(),
    getTrust: method<void, TrustState>(),
    setTrust: method<{ trusted: boolean }, TrustState>({ mutates: true }),
  },
  streams: {
    /** The current trust state, then every change. */
    watchTrust: stream<void, TrustState>(),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    workspace: typeof workspaceCapability
  }
}
