// Where an agent chat shows its steps (pure, for every client) (the tool calls its hooks reported):
// each under the turn it ran in, a turn being a prompt and everything up to
// the next one. Steps are matched to turns by time, the same for every CLI.
// A finished turn shows its steps before its final reply; a running one at
// its end. A turn from before the runtime kept steps (`stepsSince`) that the
// agent answered shows a ghost: something ran there, not what. Some CLIs
// date prompts to the minute, so only a turn over a minute older is one.

import type { AgentConversation, AgentStep, AgentStepGroup } from './conversation'

/** How coarsely a CLI's store may date a prompt. */
const STORE_PRECISION_MS = 60_000

const timeOf = (iso: string | undefined): number | null => {
  if (!iso) return null
  const time = Date.parse(iso)
  return Number.isNaN(time) ? null : time
}

export function agentStepGroups(conversation: Pick<AgentConversation, 'status' | 'messages' | 'steps' | 'stepsSince'>): AgentStepGroup[] {
  const { messages } = conversation
  // Each turn's start: its prompt's time, or the turn before's when the
  // store did not record one.
  const turns: Array<{ index: number; time: number }> = []
  let last = -Infinity
  messages.forEach((message, index) => {
    if (message.role !== 'user') return
    last = Math.max(last, timeOf(message.createdAt) ?? last)
    turns.push({ index, time: last })
  })
  if (turns.length === 0) return []

  const stepsOf: AgentStep[][] = turns.map(() => [])
  for (const step of conversation.steps) {
    const time = timeOf(step.at)
    if (time === null) continue
    let turn = -1
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].time <= time) { turn = i; break }
    }
    if (turn >= 0) stepsOf[turn].push(step)
  }

  const since = timeOf(conversation.stepsSince) ?? -Infinity
  const groups: AgentStepGroup[] = []
  turns.forEach((turn, i) => {
    const end = i + 1 < turns.length ? turns[i + 1].index : messages.length
    const running = i === turns.length - 1 && conversation.status === 'running'
    let reply = -1
    for (let index = end - 1; index > turn.index; index--) {
      if (messages[index].role === 'assistant') { reply = index; break }
    }
    const before = running || reply < 0 ? end : reply
    const steps = stepsOf[i]
    if (steps.length > 0) groups.push({ before, steps, ghost: false })
    else if (!running && reply >= 0 && turn.time < since - STORE_PRECISION_MS) groups.push({ before, steps: [], ghost: true })
  })
  return groups
}

/** The step the agent last completed in the turn it is running, or null. */
export function agentActivity(conversation: Pick<AgentConversation, 'status' | 'messages' | 'steps' | 'stepsSince'>): AgentStep | null {
  if (conversation.status !== 'running') return null
  const groups = agentStepGroups(conversation)
  const group = groups[groups.length - 1]
  if (!group || group.ghost || group.before !== conversation.messages.length) return null
  return group.steps[group.steps.length - 1] ?? null
}
