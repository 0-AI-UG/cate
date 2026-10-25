// Live agent conversations (the `agents.conversation` channel). One watch per
// panel, shared by every subscriber: it reads the conversation with the
// agent's state, so a turn that ended goes out with its reply. It looks again
// when the panel's agent state changes (and twice shortly after, for a CLI
// that writes its store just after its hook), every half second while the
// agent works and every few seconds while it is there; a look reads the
// session store only when its stamp moved. A turn's end waits for its reply:
// the hooks often say a turn ended before the CLI wrote its last reply to
// the store, so until the store shows one (or a moment passed) the
// conversation still reads as running, and the reply and the end go out
// together. The steps (tool calls the hooks
// report) are kept for every panel that hosts an agent, watched or not, in
// memory only, and go out as they come, and so do the prompts on their way
// to the agent (prompts.ts).

import { diffAgentConversation, type AgentConversation, type AgentConversationChange, type AgentStep } from '../contract'
import type { AgentTerminals } from './core'
import type { AgentPanels } from './panels'
import type { AgentPrompts } from './prompts'

export interface AgentConversationsDeps {
  panels: Pick<AgentPanels, 'state' | 'subscribe'>
  terminals: Pick<AgentTerminals, 'conversation' | 'conversationStamp' | 'onStep'>
  prompts: Pick<AgentPrompts, 'of' | 'onChange'>
  /** Tests: the look cadence while working and otherwise, the looks after a
   *  state change, and how long a turn's end waits for its reply. */
  workingMs?: number
  presentMs?: number
  settleMs?: readonly number[]
  endMs?: number
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
  /** When the agent's turn ended while its reply was not read yet. */
  ending: number | null
}

const WORKING_MS = 250
const PRESENT_MS = 3_000
const SETTLE_MS = [400, 1_500] as const
/** How long a turn's end waits for its reply to show in the store. */
const END_MS = 1_500
/** The steps kept per panel, the latest; past it the oldest go
 *  `TRIM_STEPS` at a time, so the watchers get them all again only then. */
const MAX_STEPS = 500
const TRIM_STEPS = 100

/** The conversation ends in a reply: an assistant message, and no step the
 *  agent took after it (one would mean a later reply is still on its way). */
function replied({ messages, steps }: AgentConversation): boolean {
  const last = messages[messages.length - 1]
  if (last?.role !== 'assistant') return false
  const at = last.createdAt ? Date.parse(last.createdAt) : NaN
  const step = steps[steps.length - 1]
  return Number.isNaN(at) || !step || !(Date.parse(step.at) > at)
}

export function createAgentConversations(deps: AgentConversationsDeps): AgentConversations {
  const { panels, terminals, prompts } = deps
  const workingMs = deps.workingMs ?? WORKING_MS
  const presentMs = deps.presentMs ?? PRESENT_MS
  const settleMs = deps.settleMs ?? SETTLE_MS
  const endMs = deps.endMs ?? END_MS
  const watches = new Map<string, Watch>()
  const steps = new Map<string, AgentStep[]>()
  const stepsSince = new Date().toISOString()
  const stepsOf = (panelId: string): AgentStep[] => steps.get(panelId) ?? []

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
    const state = panels.state(panelId)
    const delay = state?.status === 'running' || watch.ending !== null ? workingMs : state?.present ? presentMs : null
    if (delay === null || watches.get(panelId) !== watch) return
    watch.tick = setTimeout(() => { void look(panelId, watch, false) }, delay)
    watch.tick.unref?.()
  }

  const read = async (panelId: string, watch: Watch, forced: boolean): Promise<AgentConversation> => {
    const state = panels.state(panelId)
    let messages = watch.current.messages
    if (state?.session) {
      const stamp = await terminals.conversationStamp(panelId).catch(() => null)
      if (forced || stamp === null || stamp !== watch.stamp) {
        const conversation = await terminals.conversation(panelId).catch(() => null)
        if (conversation) {
          messages = conversation.messages
          watch.stamp = stamp
        }
      }
    }
    const next = {
      status: state?.status ?? null,
      canReceivePrompt: state?.canReceivePrompt ?? false,
      messages,
      steps: stepsOf(panelId),
      stepsSince,
      prompts: prompts.of(panelId),
    }
    // The turn ended and its reply is not read yet: it still runs.
    if (watch.current.status === 'running' && next.status !== 'running' && !replied(next)) {
      watch.ending ??= Date.now()
      if (Date.now() - watch.ending < endMs) return { ...next, status: 'running', canReceivePrompt: false }
    }
    watch.ending = null
    return next
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

  const offPanels = panels.subscribe((change) => {
    for (const panelId of Object.keys(change)) {
      // Closed, or no agent any more: its steps go.
      if (!panels.state(panelId)) steps.delete(panelId)
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

  const offSteps = terminals.onStep((panelId, step) => {
    const kept = [...stepsOf(panelId), step]
    steps.set(panelId, kept.length > MAX_STEPS ? kept.slice(TRIM_STEPS) : kept)
    const watch = watches.get(panelId)
    if (watch?.ready) publish(watch, { ...watch.current, steps: stepsOf(panelId) })
  })

  const offPrompts = prompts.onChange((panelId) => {
    const watch = watches.get(panelId)
    if (watch?.ready) publish(watch, { ...watch.current, prompts: prompts.of(panelId) })
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
          current: { status: null, canReceivePrompt: false, messages: [], steps: [], stepsSince, prompts: [] },
          ready: false,
          stamp: undefined,
          reading: false,
          again: false,
          forced: false,
          tick: null,
          settles: [],
          ending: null,
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
      offPanels()
      offSteps()
      offPrompts()
      for (const [panelId, watch] of [...watches]) stop(panelId, watch)
    },
  }
}
