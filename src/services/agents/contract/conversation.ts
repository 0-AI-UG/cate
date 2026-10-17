import type { AgentToolCall } from './hooks'
import type { AgentId } from './registry'
import type { AgentStatus } from './session'

/** One visible turn of an agent conversation. Tool calls, reasoning, injected
 *  context and other machine records are deliberately not messages. */
export interface AgentConversationMessage {
  role: 'user' | 'assistant'
  text: string
  /** ISO timestamp, when the session store records one. */
  createdAt?: string
}

/** A tool call the agent completed, as its hooks reported it
 *  (`AgentHookSpec.toolCall`, the same for every CLI). Kept only in the
 *  runtime's memory: what ran before it started has no steps. */
export interface AgentStep {
  /** The tool's name as the CLI calls it. */
  tool: string
  /** What it worked on (a command, a path, a pattern), one line. */
  subject?: string
  /** ISO timestamp, the runtime's clock. */
  at: string
}

/** Steps a chat shows together before message `before` (the message count:
 *  at the end); a ghost stands for steps that ran before the runtime kept
 *  them (`agentStepGroups`). */
export interface AgentStepGroup {
  before: number
  steps: AgentStep[]
  ghost: boolean
}

/** A panel's agent conversation as the `agents.conversation` channel carries
 *  it: the messages and the agent's state, read together, so a turn that
 *  ended arrives with its reply. A message's id is its index. */
export interface AgentConversation {
  /** Null while the panel hosts no agent. */
  status: AgentStatus | null
  canReceivePrompt: boolean
  messages: AgentConversationMessage[]
  /** The panel's steps in the order they came. */
  steps: AgentStep[]
  /** When the runtime began keeping steps (ISO): turns before it have none. */
  stepsSince: string
}

/** A change to an `AgentConversation`: the messages from index `from` on are
 *  replaced by `messages` (a reply growing, a turn appended), and the steps
 *  from `stepsFrom` on by `steps`. */
export interface AgentConversationChange {
  status?: AgentStatus | null
  canReceivePrompt?: boolean
  from?: number
  messages?: AgentConversationMessage[]
  stepsFrom?: number
  steps?: AgentStep[]
  stepsSince?: string
}

const sameMessage = (a: AgentConversationMessage, b: AgentConversationMessage): boolean =>
  a.role === b.role && a.text === b.text && a.createdAt === b.createdAt

const sameStep = (a: AgentStep, b: AgentStep): boolean =>
  a.tool === b.tool && a.subject === b.subject && a.at === b.at

/** Where `after` stops sharing `before`'s items, or null when it does not. */
function firstChange<T>(before: readonly T[], after: readonly T[], same: (a: T, b: T) => boolean): number | null {
  let from = 0
  const shared = Math.min(before.length, after.length)
  while (from < shared && same(before[from], after[from])) from++
  return from < before.length || from < after.length ? from : null
}

/** Input fields that say what a tool call worked on, in the spellings the
 *  CLIs use; the first one present is the step's subject. */
const SUBJECT_FIELDS = [
  'command', 'cmd', 'file_path', 'filePath', 'path', 'target_file', 'pattern', 'query', 'url', 'description', 'prompt',
] as const
const MAX_SUBJECT = 160

function subjectOf(input: unknown): string | undefined {
  const value = typeof input === 'string' ? input : (() => {
    if (!input || typeof input !== 'object') return undefined
    const fields = input as Record<string, unknown>
    for (const field of SUBJECT_FIELDS) {
      const candidate = fields[field]
      if (typeof candidate === 'string' && candidate.trim()) return candidate
      if (Array.isArray(candidate) && candidate.every((part) => typeof part === 'string') && candidate.length) return candidate.join(' ')
    }
    return undefined
  })()
  const line = value?.trim().split('\n')[0]?.trim()
  if (!line) return undefined
  return line.length > MAX_SUBJECT ? `${line.slice(0, MAX_SUBJECT - 1)}…` : line
}

/** The step a reported tool call shows as; read the same way for every CLI.
 *  `files` are the checkout files it edited, which name it when there are
 *  any (an edit's input may be a whole patch). */
export function agentStep(call: Pick<AgentToolCall, 'name' | 'input'>, at: string, files: readonly string[] = []): AgentStep {
  const subject = files.length ? subjectOf(files.join(', ')) : subjectOf(call.input)
  return { tool: call.name.trim() || 'Tool', ...(subject ? { subject } : {}), at }
}

/** The change from `before` to `after`, or null when nothing changed. */
export function diffAgentConversation(before: AgentConversation, after: AgentConversation): AgentConversationChange | null {
  const change: AgentConversationChange = {}
  if (before.status !== after.status) change.status = after.status
  if (before.canReceivePrompt !== after.canReceivePrompt) change.canReceivePrompt = after.canReceivePrompt
  const from = firstChange(before.messages, after.messages, sameMessage)
  if (from !== null) {
    change.from = from
    change.messages = after.messages.slice(from)
  }
  const stepsFrom = firstChange(before.steps, after.steps, sameStep)
  if (stepsFrom !== null) {
    change.stepsFrom = stepsFrom
    change.steps = after.steps.slice(stepsFrom)
  }
  if (before.stepsSince !== after.stepsSince) change.stepsSince = after.stepsSince
  return Object.keys(change).length > 0 ? change : null
}

export function applyAgentConversationChange(conversation: AgentConversation, change: AgentConversationChange): AgentConversation {
  return {
    status: change.status !== undefined ? change.status : conversation.status,
    canReceivePrompt: change.canReceivePrompt ?? conversation.canReceivePrompt,
    messages: change.from !== undefined
      ? [...conversation.messages.slice(0, change.from), ...(change.messages ?? [])]
      : conversation.messages,
    steps: change.stepsFrom !== undefined
      ? [...conversation.steps.slice(0, change.stepsFrom), ...(change.steps ?? [])]
      : conversation.steps,
    stepsSince: change.stepsSince ?? conversation.stepsSince,
  }
}

/** What identifies one agent CLI session on the runtime host that ran it.
 *  Hook events carry the transcript path for some CLIs; a persisted resume
 *  stamp does not, so every session store also locates a session from
 *  `sessionId` (+ `cwd`). */
export interface AgentSessionLocator {
  agentId: AgentId
  sessionId: string
  cwd?: string
  profile?: string
  transcriptPath?: string
}
