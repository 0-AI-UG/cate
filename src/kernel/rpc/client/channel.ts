// Mirrors a session channel on the client: keeps the latest snapshot, folds
// changes into it and reopens the subscription after a revision gap. When the
// runtime ends a channel that was live (a panel replaced under the same id
// ends its old session's channel), the stale snapshot is dropped and the
// channel reopened once: a replaced panel's new session answers with its
// snapshot, a removed panel's refusal ends it for good.

import {
  applyShallowPatch,
  reduceChannel,
  type ChannelEvent,
  type ChannelState,
  type Subscription,
} from '../contract'

export interface ChannelMirror<S> {
  get(): ChannelState<S> | null
  /** Every new state; null once the channel ended (its snapshot is stale). */
  subscribe(listener: (state: ChannelState<S> | null) => void): () => void
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
  const listeners = new Set<(state: ChannelState<S> | null) => void>()
  const notify = (next: ChannelState<S> | null) => {
    for (const listener of [...listeners]) listener(next)
  }
  let sub = attach()

  function attach(): Subscription<ChannelEvent<S, C>, unknown> {
    const next = open()
    let live = false
    const ended = () => {
      if (disposed || sub !== next || !live) return
      state = null
      notify(null)
      sub = attach()
    }
    next.done.then(ended, ended)
    next.onEvent((event) => {
      if (disposed || sub !== next) return
      live = true
      const reduced = reduceChannel(state, event, apply)
      if (!reduced) {
        state = null
        next.cancel()
        sub = attach()
        return
      }
      state = reduced
      notify(reduced)
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
