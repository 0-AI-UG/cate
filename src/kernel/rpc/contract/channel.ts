// Session channels (architecture 6, 11.2, 13.4): one subscription carrying a
// snapshot, then its changes, plus a byte stream (terminal output) or Yjs
// updates (editor buffers) as binary chunks on the same stream, and typed ops
// sent back. Generic: panels/framework serves it as the `session` capability
// with each panel's schema; the document mirror uses the same shape.

import { stream, type StreamSpec } from './capability'

export type ChannelBytes = 'none' | 'raw' | 'yjs'

export interface ChannelSchema<S = unknown, C = unknown, Op = unknown> {
  readonly kind: 'channel'
  /** What the binary chunks on the channel's stream are. */
  readonly bytes: ChannelBytes
  readonly __types?: { snapshot: S; change: C; op: Op }
}

/** Declares a channel. By default a change is a shallow patch of the snapshot. */
export function channel<S, C = Partial<S>, Op = never>(opts: { bytes?: ChannelBytes } = {}): ChannelSchema<S, C, Op> {
  return { kind: 'channel', bytes: opts.bytes ?? 'none' }
}

/** Events on a channel's stream. `rev` increases by one per change; a
 *  snapshot restarts the count. */
export type ChannelEvent<S, C> =
  | { kind: 'snapshot'; rev: number; snapshot: S }
  | { kind: 'change'; rev: number; change: C }

/** A stream declaration for a channel subscription taking params `P`. */
export function channelStream<P, S, C = Partial<S>>(opts: { bytes?: boolean } = {}): StreamSpec<P, ChannelEvent<S, C>, void> {
  return stream<P, ChannelEvent<S, C>, void>({ bytes: opts.bytes })
}

export interface ChannelState<S> {
  rev: number
  snapshot: S
}

/**
 * Folds one channel event into the mirrored state. Returns null when a change
 * does not follow the current revision (a gap): the caller resubscribes.
 */
export function reduceChannel<S, C>(
  state: ChannelState<S> | null,
  event: ChannelEvent<S, C>,
  apply: (snapshot: S, change: C) => S,
): ChannelState<S> | null {
  if (event.kind === 'snapshot') return { rev: event.rev, snapshot: event.snapshot }
  if (!state || event.rev !== state.rev + 1) return null
  return { rev: event.rev, snapshot: apply(state.snapshot, event.change) }
}

export function applyShallowPatch<S extends object>(snapshot: S, patch: Partial<S>): S {
  return { ...snapshot, ...patch }
}
