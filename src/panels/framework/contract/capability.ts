// The `session` capability (session channels of panel sessions) and the
// `surface` capability (runtime -> driving client page operations, 10.2).

import { channelStream, defineCapability, method, stream, type WireError } from '@kernel/rpc/contract'
import type { JsonObject, PanelId } from '@workspace/document/contract'

export const sessionCapability = defineCapability('session', {
  methods: {
    /** Runs one typed op on the panel's session. `gone` once the panel is removed. */
    op: method<{ panelId: PanelId; op: unknown }, unknown>({ mutates: true }),
  },
  streams: {
    /** The session's snapshot, then its changes (shallow patches), plus the
     *  panel's byte or Yjs stream as binary chunks. Bytes written by the
     *  client go to the session. */
    subscribe: channelStream<{ panelId: PanelId }, JsonObject, JsonObject>(),
  },
})

/** A page operation the runtime asks a driving client to run on a panel's
 *  native surface. */
export interface SurfaceRequest {
  requestId: number
  /** Null for an op of no panel (a browser code cell). */
  panelId: PanelId | null
  op: string
  args?: unknown
}

export const surfaceCapability = defineCapability('surface', {
  methods: {
    reply: method<{ requestId: number; result?: unknown; error?: WireError }, void>(),
  },
  streams: {
    /** Clients with `webview` or `pageDriver` subscribe and answer each
     *  request with `reply`; each gets only ops it has the feature for. */
    requests: stream<void, SurfaceRequest>(),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    session: typeof sessionCapability
    surface: typeof surfaceCapability
  }
}
