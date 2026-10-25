// Files that go with a prompt (a photo from the phone, a picked file): paths
// on the runtime's machine. The prompt is typed into the agent's terminal,
// and several CLIs turn an image path in typed text into an attachment of
// their own asynchronously, dropping the Enter that follows (verified live by
// runtime/live/promptInput.itest.ts). So a path is typed only where the CLI
// has no submit hook to take it, and never alone.

import { AGENT_DEFS, type AgentId } from './registry'

/** Typed for a prompt that is only attachments. */
export const ATTACHMENTS_ONLY_PROMPT = 'See the attached files.'

/** At most this many attachments go with one prompt. */
export const MAX_PROMPT_ATTACHMENTS = 20

/** A valid attachment list: absolute paths, one line each. */
export function isPromptAttachments(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_PROMPT_ATTACHMENTS
    && value.every((path) => typeof path === 'string' && path.startsWith('/') && !/[\0\r\n]/.test(path))
}

/** What reaches the agent for a prompt: `text` is typed (or passed at
 *  launch), `context` goes through its submit hook with the turn (null:
 *  none). An agent not known yet gets the paths typed. */
export function agentPromptInput(agentId: AgentId | null, prompt: string, attachments: readonly string[] = []): { text: string; context: string | null } {
  if (attachments.length === 0) return { text: prompt, context: null }
  const text = prompt.trim() ? prompt : ATTACHMENTS_ONLY_PROMPT
  if (agentId && AGENT_DEFS[agentId].promptContextHook) {
    return { text, context: `Files attached to this prompt:\n${attachments.map((path) => `- ${path}`).join('\n')}` }
  }
  return { text: `${text}\n\n${attachments.join('\n')}`, context: null }
}
