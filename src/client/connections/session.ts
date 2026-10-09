// Session channel subscriptions of one connection, shared by every view of a
// panel: the first subscriber opens the channel, the last release closes it.

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
}

export class SessionSubscriptions {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly session: CapabilityProxy<typeof sessionCapability>) {}

  acquire<S = unknown>(panelId: string): SessionHandle<S> {
    const entry = this.entries.get(panelId) ?? this.openEntry(panelId)
    entry.refs++
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
        this.entries.delete(panelId)
        entry.mirror.dispose()
      },
    }
  }

  /** Open channels and their reference counts. */
  counts(): Map<string, number> {
    return new Map([...this.entries].map(([id, e]) => [id, e.refs]))
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.mirror.dispose()
    this.entries.clear()
  }

  private openEntry(panelId: string): Entry {
    // Resumed on reconnect: the channel restarts with a snapshot.
    const open = () => this.session.subscribe({ panelId }, { resume: true }) as Subscription<ChannelEvent<unknown, unknown>, void>
    const entry: Entry = { mirror: mirrorChannel<unknown, unknown>(open), refs: 0 }
    this.entries.set(panelId, entry)
    return entry
  }
}
