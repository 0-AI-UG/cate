// Where an agent chat shows its steps (pure, for every client) (the tool calls its hooks reported):
// each under the turn it ran in, a turn being a prompt and everything up to
// the next one. Steps are matched to turns by time, the same for every CLI.
// A step shows before the turn's first reply dated after it, so steps sit
// between the replies they came between; one no reply follows shows before
// the final reply of a finished turn, at the end of a running one. A turn from before the runtime kept steps (`stepsSince`) that the
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
    const fallback = running || reply < 0 ? end : reply
    const replies: Array<{ index: number; time: number }> = []
    for (let index = turn.index + 1; index < end; index++) {
      const time = timeOf(messages[index].createdAt)
      if (messages[index].role === 'assistant' && time !== null) replies.push({ index, time })
    }
    const steps = stepsOf[i]
    for (const step of steps) {
      const time = timeOf(step.at) ?? Infinity
      const before = replies.find((reply) => reply.time > time)?.index ?? fallback
      const group = groups[groups.length - 1]
      if (group && group.before === before && !group.ghost) group.steps.push(step)
      else groups.push({ before, steps: [step], ghost: false })
    }
    if (steps.length > 0) return
    if (!running && reply >= 0 && turn.time < since - STORE_PRECISION_MS) groups.push({ before: fallback, steps: [], ghost: true })
  })
  return groups
}
