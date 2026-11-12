import type { AgentHookEventKind, AgentId } from '../../contract'

/** Native commands used only to drive the real CLI fixtures. Production
 * observes confirmed lifecycle events; it never interprets typed commands. */
export const CONVERSATION_RESET_COMMANDS: Record<AgentId, string> = {
  'claude-code': '/clear', codex: '/clear', cursor: '/new-chat', grok: '/clear',
  opencode: '/new', pi: '/new', kiro: '/clear',
}

// Independent expectations: observing an HTTP post is insufficient if Cate
// stops normalizing it. OpenCode's tool-part event is verified through storage.
export const NATIVE_HOOK_KINDS: Record<string, AgentHookEventKind | 'stored-edit'> = {
  session_start: 'session-start', session_shutdown: 'session-end', session_tree: 'session-start', session_info_changed: 'session-start',
  session_before_compact: 'turn-start', session_compact: 'turn-end', session_compact_failed: 'turn-end',
  before_agent_start: 'turn-start', agent_settled: 'turn-end', ui_prompt_start: 'permission-wait', ui_prompt_end: 'turn-resume', tool_execution_end: 'turn-resume',
  SessionStart: 'session-start', sessionStart: 'session-start',
  'session.created': 'session-start',
  UserPromptSubmit: 'turn-start', beforeSubmitPrompt: 'turn-start',
  PermissionRequest: 'permission-check', Notification: 'permission-wait',
  'permission.asked': 'permission-wait',
  PreToolUse: 'turn-resume', PostToolUse: 'turn-resume', PostToolUseFailure: 'turn-resume',
  PermissionDenied: 'turn-resume', postToolUse: 'turn-resume', afterFileEdit: 'turn-resume',
  'permission.replied': 'turn-resume',
  Stop: 'turn-end', StopFailure: 'turn-end', StopCancelled: 'turn-end', Interrupt: 'turn-end',
  stop: 'turn-end',
  SessionEnd: 'session-end', sessionEnd: 'session-end',
  'session.status': 'turn-start', // The same native event with status=idle must also end the turn.
  'message.part.updated': 'stored-edit',
}

/** Pi-only native scenarios run in piContracts.itest.ts. Their event lists
 * participate in the same exhaustive hook-coverage guard as the shared TUI cases. */
export const PI_MANUAL_COMPACTION_CASES = [
  { success: true, hooks: ['session_before_compact', 'session_compact'] },
  { success: false, hooks: ['session_before_compact', 'session_compact_failed'] },
] as const

/** Every injected native event must be exercised by a real installed CLI.
 * Adding a production hook without a scenario fails the coverage unit test. */
export const HOOK_LIFECYCLE_CASES: Record<AgentId, Record<string, string[]>> = {
  'claude-code': {
    edit: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'],
    interrupt: [], // Cate tails the real CLI transcript's interrupt marker.
    resume: ['SessionStart', 'UserPromptSubmit', 'Stop'],
    'session-end': ['SessionEnd'],
    'session-reset': ['SessionEnd', 'SessionStart'],
    'permission-allow': ['PermissionRequest', 'Notification', 'PostToolUse'],
    'permission-deny': ['PermissionRequest', 'Notification'],
    'automatic-denial': ['PermissionDenied'],
    'tool-failure': ['PostToolUseFailure'],
    'provider-failure': ['StopFailure'],
  },
  codex: {
    'session-reset': [], // Native reset, followed by switching back to the original session.
    edit: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'],
    interrupt: ['Interrupt'],
    resume: ['SessionStart', 'UserPromptSubmit', 'Stop'],
    'permission-allow': ['PermissionRequest', 'PostToolUse'],
    'permission-deny': ['PermissionRequest', 'Interrupt'],
    'automatic-approval': ['PermissionRequest', 'PostToolUse', 'Stop'],
    'tool-failure': ['PostToolUse', 'Stop'],
  },
  cursor: {
    'session-reset': [], // Native reset, followed by switching back to the original session.
    edit: ['sessionStart', 'beforeSubmitPrompt', 'afterFileEdit', 'postToolUse', 'stop'],
    interrupt: ['stop'],
    resume: ['sessionStart', 'beforeSubmitPrompt', 'stop'],
    'session-end': ['sessionEnd'],
  },
  grok: {
    'session-reset': [], // Native reset, followed by switching back to the original session.
    edit: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'],
    interrupt: ['StopCancelled'],
    resume: ['SessionStart', 'UserPromptSubmit', 'Stop'],
    'session-end': ['SessionEnd'],
    'permission-allow': ['Notification', 'PostToolUse'],
    'permission-deny': ['Notification', 'StopCancelled'],
    'tool-failure': ['PostToolUse', 'Stop'],
    'provider-failure': ['StopFailure'],
  },
  opencode: {
    'session-reset': [], // Native reset, followed by switching back to the original session.
    edit: ['session.created', 'session.status', 'message.part.updated'],
    interrupt: ['session.status'],
    resume: ['session.status'],
    'permission-allow': ['permission.asked', 'permission.replied', 'message.part.updated'],
    'permission-deny': ['permission.asked', 'permission.replied'],
    'tool-failure': ['message.part.updated', 'session.status'],
  },
  pi: {
    edit: ['session_start', 'before_agent_start', 'tool_execution_end', 'agent_settled'],
    interrupt: ['agent_settled'],
    resume: ['session_start', 'before_agent_start', 'agent_settled'],
    'session-end': ['session_shutdown'],
    'session-reset': ['session_shutdown', 'session_start'],
    'permission-allow': ['ui_prompt_start', 'ui_prompt_end', 'tool_execution_end'],
    'permission-deny': ['ui_prompt_start', 'ui_prompt_end'],
    'session-metadata': ['session_tree', 'session_info_changed'],
    'tool-failure': ['tool_execution_end', 'agent_settled'],
    'provider-failure': ['agent_settled'],
  },
  kiro: {
    'session-reset': [], // Native reset, followed by switching back to the original session.
    edit: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'],
    interrupt: [], // V3 has no native interrupt hook; Cate uses the PTY input.
    resume: ['SessionStart', 'UserPromptSubmit', 'Stop'],
  },
}

export function selectHookLifecycleCases(agentId: AgentId, selection?: string): string[] {
  const available = Object.keys(HOOK_LIFECYCLE_CASES[agentId])
  if (selection === undefined) return available
  const names = selection.split(',').map((name) => name.trim())
  const all = new Set(Object.values(HOOK_LIFECYCLE_CASES).flatMap(Object.keys))
  for (const name of names) if (!all.has(name)) throw new Error(`Unknown hook lifecycle case: ${JSON.stringify(name)}`)
  return available.filter((name) => names.includes(name))
}
