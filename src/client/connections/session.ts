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
  /** Bytes to the session (keystrokes, Yjs updates). */
  write(bytes: Uint8Array): void
  /** The panel's byte stream; survives resubscribes. */
  onBytes(listener: (bytes: Uint8Array) => void): () => void
  /** Drops this reference. Releasing twice is harmless. */
  release(): void
}

interface Entry {
  mirror: ChannelMirror<unknown>
  bytes: Set<(bytes: Uint8Array) => void>
  refs: number
}

export class SessionSubscriptions {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly session: CapabilityProxy<typeof sessionCapability>) {}

  acquire<S = unknown>(panelId: string): SessionHandle<S> {
    const entry = this.entries.get(panelId) ?? this.openEntry(panelId)
    entry.refs++
    const mirror = entry.mirror as ChannelMirror<S>
    const own: Set<(bytes: Uint8Array) => void> = new Set()
    let released = false
    return {
      panelId,
      getSnapshot: () => mirror.get(),
      subscribe: (listener) => mirror.subscribe(() => listener()),
      send: (op) => this.session.op({ panelId, op }),
      write: (bytes) => mirror.subscription.write(bytes),
      onBytes: (listener) => {
        own.add(listener)
        entry.bytes.add(listener)
        return () => {
          own.delete(listener)
          entry.bytes.delete(listener)
        }
      },
      release: () => {
        if (released) return
        released = true
        for (const listener of own) entry.bytes.delete(listener)
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
    const bytes = new Set<(bytes: Uint8Array) => void>()
    const open = () => {
      // Resumed on reconnect: the channel restarts with a snapshot.
      const sub = this.session.subscribe({ panelId }, { resume: true }) as Subscription<ChannelEvent<unknown, unknown>, void>
      sub.onBytes((chunk) => { for (const listener of [...bytes]) listener(chunk) })
      return sub
    }
    const entry: Entry = { mirror: mirrorChannel<unknown, unknown>(open), bytes, refs: 0 }
    this.entries.set(panelId, entry)
    return entry
  }
}
