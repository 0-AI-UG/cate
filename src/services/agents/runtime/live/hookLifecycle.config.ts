import type { AgentHookEventKind, AgentId } from '../../contract'

// Independent expectations: observing an HTTP post is insufficient if Cate
// stops normalizing it. OpenCode's tool-part event is verified through storage.
export const NATIVE_HOOK_KINDS: Record<string, AgentHookEventKind | 'approval-surface' | 'stored-edit'> = {
  SessionStart: 'session-start', sessionStart: 'session-start',
  'session.created': 'session-start', on_session_start: 'session-start', on_session_reset: 'session-start',
  UserPromptSubmit: 'turn-start', beforeSubmitPrompt: 'turn-start', pre_llm_call: 'turn-start',
  PermissionRequest: 'permission-check', Notification: 'permission-wait',
  'permission.asked': 'permission-wait', pre_approval_request: 'approval-surface',
  PreToolUse: 'turn-resume', PostToolUse: 'turn-resume', PostToolUseFailure: 'turn-resume',
  PermissionDenied: 'turn-resume', postToolUse: 'turn-resume', afterFileEdit: 'turn-resume',
  'permission.replied': 'turn-resume', post_approval_response: 'turn-resume', post_tool_call: 'turn-resume',
  Stop: 'turn-end', StopFailure: 'turn-end', StopCancelled: 'turn-end', Interrupt: 'turn-end',
  stop: 'turn-end', on_session_end: 'turn-end',
  SessionEnd: 'session-end', sessionEnd: 'session-end', on_session_finalize: 'session-end',
  'session.status': 'turn-start', // The same native event with status=idle must also end the turn.
  'message.part.updated': 'stored-edit',
}

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
    edit: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'],
    interrupt: ['Interrupt'],
    resume: ['SessionStart', 'UserPromptSubmit', 'Stop'],
    'permission-allow': ['PermissionRequest', 'PostToolUse'],
    'permission-deny': ['PermissionRequest', 'Interrupt'],
    'automatic-approval': ['PermissionRequest', 'PostToolUse', 'Stop'],
    'tool-failure': ['PostToolUse', 'Stop'],
  },
  cursor: {
    edit: ['sessionStart', 'beforeSubmitPrompt', 'afterFileEdit', 'postToolUse', 'stop'],
    interrupt: ['stop'],
    resume: ['sessionStart', 'beforeSubmitPrompt', 'stop'],
    'session-end': ['sessionEnd'],
  },
  grok: {
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
    edit: ['session.created', 'session.status', 'message.part.updated'],
    interrupt: ['session.status'],
    resume: ['session.status'],
    'permission-allow': ['permission.asked', 'permission.replied', 'message.part.updated'],
    'permission-deny': ['permission.asked', 'permission.replied'],
    'tool-failure': ['message.part.updated', 'session.status'],
  },
  hermes: {
    edit: ['on_session_start', 'pre_llm_call', 'post_tool_call', 'on_session_end'],
    interrupt: ['on_session_end'],
    resume: ['on_session_start', 'pre_llm_call', 'on_session_end'],
    'session-end': ['on_session_finalize'],
    'session-reset': ['on_session_reset'],
    'permission-allow': ['pre_approval_request', 'post_approval_response', 'post_tool_call'],
    'permission-deny': ['pre_approval_request', 'post_approval_response', 'post_tool_call'],
    'automatic-approval': ['pre_approval_request', 'post_approval_response', 'post_tool_call'],
    'tool-failure': ['post_tool_call', 'on_session_end'],
  },
  kiro: {
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
