// Session channel subscriptions of one connection, shared by every view of a
// panel: the first subscriber opens the channel, and it closes `lingerMs`
// after the last release, so going back to a panel finds its snapshot.

import type { CapabilityProxy, ChannelEvent, ChannelState, Subscription } from '@kernel/rpc/contract'
import { mirrorChannel, type ChannelMirror } from '@kernel/rpc/client'
import type { sessionCapability } from '@panels/framework/contract'

export interface SessionHandle<S = unknown> {
  readonly panelId: string
  /** Null until the first snapshot. */
  getSnapshot(): ChannelState<S> | null
  subscribe(listener: () => void): () => void
  /** Runs one typed op on the session. */
  send(op: unknown): Promise<unknown>
  /** Drops this reference. Releasing twice is harmless. */
  release(): void
}

interface Entry {
  mirror: ChannelMirror<unknown>
  refs: number
  /** Closes the channel; set while nothing holds it. */
  closing: ReturnType<typeof setTimeout> | null
}

/** How long a released session stays open for the next view of its panel. */
export const SESSION_LINGER_MS = 30_000

export class SessionSubscriptions {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly session: CapabilityProxy<typeof sessionCapability>,
    private readonly lingerMs = SESSION_LINGER_MS,
  ) {}

  acquire<S = unknown>(panelId: string): SessionHandle<S> {
    const entry = this.entries.get(panelId) ?? this.openEntry(panelId)
    entry.refs++
    if (entry.closing) clearTimeout(entry.closing)
    entry.closing = null
    const mirror = entry.mirror as ChannelMirror<S>
    let released = false
    return {
      panelId,
      getSnapshot: () => mirror.get(),
      subscribe: (listener) => mirror.subscribe(() => listener()),
      send: (op) => this.session.op({ panelId, op }),
      release: () => {
        if (released) return
        released = true
        if (--entry.refs > 0 || this.entries.get(panelId) !== entry) return
        entry.closing = setTimeout(() => {
          if (entry.refs > 0 || this.entries.get(panelId) !== entry) return
          this.entries.delete(panelId)
          entry.mirror.dispose()
        }, this.lingerMs)
      },
    }
  }

  /** Open channels and their reference counts. */
  counts(): Map<string, number> {
    return new Map([...this.entries].map(([id, e]) => [id, e.refs]))
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.closing) clearTimeout(entry.closing)
      entry.mirror.dispose()
    }
    this.entries.clear()
  }

  private openEntry(panelId: string): Entry {
    // Resumed on reconnect: the channel restarts with a snapshot.
    const open = () => this.session.subscribe({ panelId }, { resume: true }) as Subscription<ChannelEvent<unknown, unknown>, void>
    const entry: Entry = { mirror: mirrorChannel<unknown, unknown>(open), refs: 0, closing: null }
    this.entries.set(panelId, entry)
    return entry
  }
}
