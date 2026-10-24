// An agent chat as the app shows it (`agents.watch`): one list of items with
// ids that stay while the conversation grows, whether a turn is open, and the
// prompts on their way as the runtime keeps them (queued, sending, failed).
// The conversation comes from two places at their own pace (the agent's
// state from its hooks, its messages from its session store), so this keeps
// what is on screen steady:
// - A message's id is its place (`m3`), and the prompt being sent waits
//   under the id it will have, so it stays where it is once it shows. The
//   runtime lets go of a prompt when its turn starts, which may be a moment
//   before the store shows it: it stays on screen until the conversation
//   has a new message.
// - A step stays in the group it first showed in; a message read late does
//   not move steps already on screen.
// - A turn is open while a prompt is being sent and while the agent works.
// A new agent's first prompt (passed at launch) shows as being sent until
// the conversation has a prompt of the person's.

import { ATTACHMENTS_ONLY_PROMPT, agentStepGroups, type AgentConversation, type AgentPrompt, type AgentStep } from '@services/agents/contract'
import type { MobileChat, MobileChatItem } from '../contract'

/** Why a failed prompt was not taken, as the app says it. */
export const NOT_TAKEN = 'The agent did not take it. It may still be in its terminal\'s input.'

export interface ChatTimeline {
  update(conversation: AgentConversation | null): MobileChat
}

const stepKey = (step: AgentStep): string => `${step.at}\0${step.tool}\0${step.subject ?? ''}`

/** A prompt of only attachments reads as the runtime types it. */
const promptText = ({ text, attachments }: AgentPrompt): string =>
  text.trim() || attachments.length === 0 ? text : ATTACHMENTS_ONLY_PROMPT

/** `first`: a new agent's first prompt, on its way with the agent. */
export function createChatTimeline(first: string | null = null): ChatTimeline {
  /** Where each step shows: before the message at this index. */
  let anchors = new Map<string, number>()
  /** The prompt being sent (or just taken): its text and the message count
   *  when it was seen first. */
  let held: { id: string; text: string; from: number } | null = null

  return {
    update(conversation) {
      const messages = conversation?.messages ?? []
      const prompts = conversation?.prompts ?? []
      const status = conversation?.status ?? null
      const running = status === 'running'

      if (first !== null && messages.some((message) => message.role === 'user')) first = null
      const sending = prompts.find((prompt) => prompt.state === 'sending')
      if (sending) {
        if (held?.id !== sending.id) held = { id: sending.id, text: promptText(sending), from: messages.length }
      } else if (held && (prompts.some((prompt) => prompt.id === held!.id) || messages.length > held.from)) {
        // Not taken (failed, or waiting again), or shown in the conversation.
        held = null
      }

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
      const outgoing = held?.text ?? first
      if (outgoing !== null) items.push({ kind: 'prompt', id: `m${messages.length}`, text: outgoing, sent: false })

      const open = outgoing !== null || running
      const step = running && lastStep && lastStep.before === messages.length ? lastStep.step : null
      return {
        loaded: conversation !== null,
        status,
        canReceivePrompt: conversation?.canReceivePrompt ?? false,
        queued: prompts.filter((prompt) => prompt.state === 'queued').map((prompt) => ({ id: prompt.id, text: promptText(prompt) })),
        failed: prompts.filter((prompt) => prompt.state === 'failed')
          .map((prompt) => ({ id: prompt.id, text: promptText(prompt), message: NOT_TAKEN })),
        turn: open ? { step } : null,
        items,
      }
    },
  }
}
