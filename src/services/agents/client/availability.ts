// The runtime's authoritative CLI availability, mirrored from `agents.availability`. One subscription per workspace, shared by
// every consumer and closed when the last one releases it.

import { mirrorChannel, subscribeRuntimes, tryRuntimeFor, type ChannelMirror } from '@kernel/rpc/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import type { AgentAvailability } from '../contract'

const EMPTY: AgentAvailability | null = null

interface Entry {
  refs: number
  states: AgentAvailability | null
  runtime: RuntimeProxy | null
  mirror: ChannelMirror<AgentAvailability> | null
  listeners: Set<() => void>
  stopRuntimes: () => void
}

const entries = new Map<string, Entry>()

export interface AgentAvailabilityHandle {
  getSnapshot(): AgentAvailability | null
  subscribe(listener: () => void): () => void
  /** Drops this consumer; the last release closes the stream. */
  release(): void
}

function notify(entry: Entry): void {
  for (const listener of [...entry.listeners]) {
    try { listener() } catch { /* isolate listeners */ }
  }
}

function connect(workspaceId: string, entry: Entry): void {
  const runtime = tryRuntimeFor(workspaceId)
  if (runtime === entry.runtime && (entry.mirror || !runtime)) return
  entry.mirror?.dispose()
  entry.mirror = null
  entry.runtime = runtime
  const hadStates = entry.states !== EMPTY
  entry.states = EMPTY
  if (runtime) {
    const mirror = mirrorChannel(
      () => runtime.agents.availability(undefined, { resume: true }),
      (_previous, change) => change,
    )
    mirror.subscribe((state) => {
      entry.states = state?.snapshot ?? EMPTY
      notify(entry)
    })
    entry.mirror = mirror
  }
  if (hadStates) notify(entry)
}

/** Takes a reference on the workspace's agent availability. */
export function acquireAgentAvailability(workspaceId: string): AgentAvailabilityHandle {
  let entry = entries.get(workspaceId)
  if (!entry) {
    const created: Entry = {
      refs: 0,
      states: EMPTY,
      runtime: null,
      mirror: null,
      listeners: new Set(),
      stopRuntimes: () => {},
    }
    entries.set(workspaceId, created)
    created.stopRuntimes = subscribeRuntimes(() => connect(workspaceId, created))
    connect(workspaceId, created)
    entry = created
  }
  entry.refs++
  const own = entry
  let released = false
  return {
    getSnapshot: () => own.states,
    subscribe(listener) {
      own.listeners.add(listener)
      return () => { own.listeners.delete(listener) }
    },
    release() {
      if (released) return
      released = true
      if (--own.refs > 0) return
      own.stopRuntimes()
      own.mirror?.dispose()
      own.listeners.clear()
      if (entries.get(workspaceId) === own) entries.delete(workspaceId)
    },
  }
}

/** The current states without taking a reference (empty when nobody holds one). */
export function peekAgentAvailability(workspaceId: string): AgentAvailability | null {
  return entries.get(workspaceId)?.states ?? EMPTY
}

