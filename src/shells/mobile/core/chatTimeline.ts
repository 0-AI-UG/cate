// An agent chat as the app shows it (`agents.watch`): one list of items with
// ids that stay while the conversation grows, and whether a turn is open.
// The conversation comes from two places at their own pace (the agent's
// state from its hooks, its messages from its session store), so this keeps
// what is on screen steady:
// - A message's id is its place (`m3`), and the prompt sent from here waits
//   under the id it will have, so it stays where it is once it shows.
// - A step stays in the group it first showed in; a message read late does
//   not move steps already on screen.
// - A turn is open from the prompt going out until the agent ended it (the
//   runtime sends a turn's end with its reply), and for a moment after the
//   prompt shows, while the agent has not said it took it up.

import { agentStepGroups, type AgentStep } from '@services/agents/contract'
import type { AgentChat } from '@services/agents/client'
import type { MobileChat, MobileChatItem } from '../contract'

/** How long a prompt the conversation shows keeps its turn open while the
 *  agent has not said it is working on it. */
export const TAKE_UP_MS = 8_000

export interface ChatTimeline {
  /** The chat at `now`, and when it changes with no news (a prompt's
   *  take-up ran out), or null. */
  update(chat: AgentChat, now: number): { chat: MobileChat; recheckAt: number | null }
}

const stepKey = (step: AgentStep): string => `${step.at}\0${step.tool}\0${step.subject ?? ''}`

export function createChatTimeline(): ChatTimeline {
  /** Where each step shows: before the message at this index. */
  let anchors = new Map<string, number>()
  let lastPending: string | null = null
  /** How many messages there were when the prompt went out. */
  let pendingFrom = 0
  /** A prompt showed while the agent had not taken it up, until then. */
  let takeUp: number | null = null

  return {
    update({ conversation, pending, queued }, now) {
      const messages = conversation?.messages ?? []
      const status = conversation?.status ?? null
      const running = status === 'running'

      // The prompt sent from here shows in the conversation now.
      const arrived = lastPending !== null && pending === null
        && messages.slice(pendingFrom).some((message) => message.role === 'user')
      if (arrived && !running) takeUp = now + TAKE_UP_MS
      if (pending !== null && lastPending === null) pendingFrom = messages.length
      lastPending = pending
      const lastUser = messages.findLastIndex((message) => message.role === 'user')
      const replied = lastUser >= 0 && messages.slice(lastUser + 1).some((message) => message.role === 'assistant')
      if (takeUp !== null && (running || replied || now >= takeUp)) takeUp = null

      // Steps, each where it first showed.
      const groups = conversation ? agentStepGroups(conversation) : []
      const next = new Map<string, number>()
      const byAnchor = new Map<number, AgentStep[]>()
      const ghosts = new Set<number>()
      let lastStep: { step: AgentStep; before: number } | null = null
      for (const group of groups) {
        if (group.ghost) {
          ghosts.add(group.before)
          continue
        }
        for (const step of group.steps) {
          const key = stepKey(step)
          const before = Math.min(anchors.get(key) ?? group.before, messages.length)
          next.set(key, before)
          byAnchor.set(before, [...(byAnchor.get(before) ?? []), step])
          lastStep = { step, before }
        }
      }
      anchors = next

      const items: MobileChatItem[] = []
      const stepsAt = (before: number) => {
        const steps = byAnchor.get(before)
        if (steps) items.push({ kind: 'steps', id: `s${before}`, steps, ghost: false })
        else if (ghosts.has(before)) items.push({ kind: 'steps', id: `s${before}`, steps: [], ghost: true })
      }
      messages.forEach((message, index) => {
        stepsAt(index)
        items.push(message.role === 'user'
          ? { kind: 'prompt', id: `m${index}`, text: message.text, sent: true }
          : { kind: 'reply', id: `m${index}`, text: message.text })
      })
      stepsAt(messages.length)
      if (pending !== null) items.push({ kind: 'prompt', id: `m${messages.length}`, text: pending, sent: false })

      const open = pending !== null || running || takeUp !== null
      const step = running && lastStep && lastStep.before === messages.length ? lastStep.step : null
      return {
        chat: {
          loaded: conversation !== null,
          status,
          canReceivePrompt: conversation?.canReceivePrompt ?? false,
          queued,
          turn: open ? { step } : null,
          items,
        },
        recheckAt: takeUp,
      }
    },
  }
}
