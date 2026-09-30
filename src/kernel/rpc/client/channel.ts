// Mirrors a session channel on the client: keeps the latest snapshot, folds
// changes into it and reopens the subscription after a revision gap.

import {
  applyShallowPatch,
  reduceChannel,
  type ChannelEvent,
  type ChannelState,
  type Subscription,
} from '../contract'

export interface ChannelMirror<S> {
  get(): ChannelState<S> | null
  subscribe(listener: (state: ChannelState<S>) => void): () => void
  /** The live subscription, for its byte stream and writes. Replaced after a gap. */
  readonly subscription: Subscription<ChannelEvent<S, unknown>, unknown>
  dispose(): void
}

export function mirrorChannel<S, C = Partial<S>>(
  open: () => Subscription<ChannelEvent<S, C>, unknown>,
  apply: (snapshot: S, change: C) => S = applyShallowPatch as unknown as (snapshot: S, change: C) => S,
): ChannelMirror<S> {
  let state: ChannelState<S> | null = null
  let disposed = false
  const listeners = new Set<(state: ChannelState<S>) => void>()
  let sub = attach()

  function attach(): Subscription<ChannelEvent<S, C>, unknown> {
    const next = open()
    next.onEvent((event) => {
      if (disposed || sub !== next) return
      const reduced = reduceChannel(state, event, apply)
      if (!reduced) {
        state = null
        next.cancel()
        sub = attach()
        return
      }
      state = reduced
      for (const listener of [...listeners]) listener(reduced)
    })
    return next
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    get subscription() { return sub as Subscription<ChannelEvent<S, unknown>, unknown> },
    dispose() {
      disposed = true
      listeners.clear()
      sub.cancel()
    },
  }
}
