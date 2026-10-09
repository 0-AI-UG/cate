// Live agent conversations (the `agents.conversation` channel). One watch per
// panel, shared by every subscriber: it reads the conversation with the
// agent's state, so a turn that ended goes out with its reply. It looks again
// when the panel's agent state changes (and twice shortly after, for a CLI
// that writes its store just after its hook), every half second while the
// agent works and every few seconds while it is there; a look reads the
// session store only when the runner's stamp moved.

import { diffAgentConversation, type AgentConversation, type AgentConversationChange } from '../contract'
import type { RunnerRegistry } from './registry'

export interface AgentConversationsDeps {
  registry: RunnerRegistry
  /** Tests: the look cadence while working and otherwise, and the looks after a state change. */
  workingMs?: number
  presentMs?: number
  settleMs?: readonly number[]
}

export type AgentConversationListener = (conversation: AgentConversation, change: AgentConversationChange | null) => void

export interface AgentConversations {
  /** Follows a panel's conversation: the listener gets it once read (change
   *  null), then each change. */
  watch(panelId: string, listener: AgentConversationListener): () => void
  dispose(): void
}

interface Watch {
  listeners: Set<AgentConversationListener>
  current: AgentConversation
  ready: boolean
  stamp: string | null | undefined
  reading: boolean
  /** Another look was asked for during a read; `forced` reads the store. */
  again: boolean
  forced: boolean
  tick: ReturnType<typeof setTimeout> | null
  settles: Array<ReturnType<typeof setTimeout>>
}

const WORKING_MS = 500
const PRESENT_MS = 3_000
const SETTLE_MS = [400, 1_500] as const

export function createAgentConversations(deps: AgentConversationsDeps): AgentConversations {
  const { registry } = deps
  const workingMs = deps.workingMs ?? WORKING_MS
  const presentMs = deps.presentMs ?? PRESENT_MS
  const settleMs = deps.settleMs ?? SETTLE_MS
  const watches = new Map<string, Watch>()

  const publish = (watch: Watch, next: AgentConversation): void => {
    const change = diffAgentConversation(watch.current, next)
    watch.current = next
    if (!watch.ready) {
      watch.ready = true
      for (const listener of [...watch.listeners]) listener(next, null)
      return
    }
    if (!change) return
    for (const listener of [...watch.listeners]) {
      try { listener(next, change) } catch { /* a subscriber must not break the others */ }
    }
  }

  const schedule = (panelId: string, watch: Watch): void => {
    if (watch.tick) clearTimeout(watch.tick)
    watch.tick = null
    const state = registry.sessionFor(panelId)
    const delay = state?.status === 'running' ? workingMs : state?.present ? presentMs : null
    if (delay === null || watches.get(panelId) !== watch) return
    watch.tick = setTimeout(() => { void look(panelId, watch, false) }, delay)
    watch.tick.unref?.()
  }

  const read = async (panelId: string, watch: Watch, forced: boolean): Promise<AgentConversation> => {
    const state = registry.sessionFor(panelId)
    const runner = registry.runnerFor(panelId)
    let messages = watch.current.messages
    if (state?.session && runner) {
      const stamp = await runner.conversationStamp?.(panelId).catch(() => null) ?? null
      if (forced || stamp === null || stamp !== watch.stamp) {
        const conversation = await runner.conversation(panelId).catch(() => null)
        if (conversation) {
          messages = conversation.messages
          watch.stamp = stamp
        }
      }
    }
    return { status: state?.status ?? null, canReceivePrompt: state?.canReceivePrompt ?? false, messages }
  }

  const look = async (panelId: string, watch: Watch, forced: boolean): Promise<void> => {
    if (watch.reading) {
      watch.again = true
      watch.forced ||= forced
      return
    }
    watch.reading = true
    try {
      let force = forced
      do {
        watch.again = false
        watch.forced = false
        const next = await read(panelId, watch, force)
        if (watches.get(panelId) !== watch) return
        publish(watch, next)
        force = watch.forced
      } while (watch.again)
    } finally {
      watch.reading = false
    }
    schedule(panelId, watch)
  }

  const offRegistry = registry.subscribe((change) => {
    for (const panelId of Object.keys(change)) {
      const watch = watches.get(panelId)
      if (!watch) continue
      void look(panelId, watch, true)
      for (const timer of watch.settles) clearTimeout(timer)
      watch.settles = settleMs.map((ms) => {
        const timer = setTimeout(() => { void look(panelId, watch, false) }, ms)
        timer.unref?.()
        return timer
      })
    }
  })

  const stop = (panelId: string, watch: Watch): void => {
    if (watch.tick) clearTimeout(watch.tick)
    for (const timer of watch.settles) clearTimeout(timer)
    if (watches.get(panelId) === watch) watches.delete(panelId)
  }

  return {
    watch(panelId, listener) {
      let watch = watches.get(panelId)
      if (!watch) {
        watch = {
          listeners: new Set(),
          current: { status: null, canReceivePrompt: false, messages: [] },
          ready: false,
          stamp: undefined,
          reading: false,
          again: false,
          forced: false,
          tick: null,
          settles: [],
        }
        watches.set(panelId, watch)
        void look(panelId, watch, true)
      } else if (watch.ready) {
        listener(watch.current, null)
      }
      const own = watch
      own.listeners.add(listener)
      return () => {
        own.listeners.delete(listener)
        if (own.listeners.size === 0) stop(panelId, own)
      }
    },
    dispose() {
      offRegistry()
      for (const [panelId, watch] of [...watches]) stop(panelId, watch)
    },
  }
}
