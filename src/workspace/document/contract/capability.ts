// The `document` and `presence` capabilities (architecture 9.1, 13.4).

import { defineCapability, method, stream, type ClientFeature, type DeviceInfo } from '@kernel/rpc/contract'
import type { DocOp } from './ops'
import type { ClientId, PanelId, WorkspaceDocument } from './schema'

/** The clientId of ops the runtime makes itself (a deleted conversation
 *  closing its panel, the repository writing worktree metadata). */
export const RUNTIME_CLIENT_ID: ClientId = 'runtime'

/** Events of `document.subscribe`: the full document or the missed ops
 *  first, then every applied op in order. */
export type DocumentEvent =
  | { kind: 'doc'; seq: number; epoch: string; doc: WorkspaceDocument }
  | { kind: 'op'; seq: number; op: DocOp }

/** A failed op rejects with its code (`gone`, `rejected`); a resent op that
 *  was already handled is `duplicate`. */
export type ApplyResult = { status: 'applied'; seq: number } | { status: 'duplicate' }

export const documentCapability = defineCapability('document', {
  methods: {
    apply: method<{ op: DocOp }, ApplyResult>({ mutates: true }),
  },
  streams: {
    /** With `sinceSeq` of the runtime's current `epoch` (from its last `doc`
     *  event), only the ops after it when they are still kept; otherwise the
     *  full document. */
    subscribe: stream<{ sinceSeq?: number; epoch?: string }, DocumentEvent>(),
  },
})

/** One connected client as others see it. Never persisted. */
export interface PresenceClient {
  connectionId: number
  clientId: ClientId
  device: DeviceInfo
  features: ClientFeature[]
  /** The panels the client shows. */
  viewing: PanelId[]
  focused: PanelId | null
  /** The client has the person's attention (its app has OS focus). */
  attentive: boolean
  /** Milliseconds since the epoch of its last action. */
  lastActiveAt: number
}

export interface PresenceReport {
  viewing?: PanelId[]
  /** null clears. */
  focused?: PanelId | null
  /** Not activity by itself: a window losing focus does not make its client
   *  the most recently active one. */
  attentive?: boolean
}

export type PresenceEvent = { clients: PresenceClient[]; activeClientId: ClientId | null }

export const presenceCapability = defineCapability('presence', {
  methods: {
    /** A client reports what it shows and focuses; counts as activity. */
    report: method<PresenceReport, void>(),
  },
  streams: {
    /** Every client, the current list then the list after each change. */
    subscribe: stream<void, PresenceEvent>(),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    document: typeof documentCapability
    presence: typeof presenceCapability
  }
}
