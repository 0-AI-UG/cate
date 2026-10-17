import { beforeEach, describe, expect, it } from 'vitest'
import { AGENTS, normalizeAgentHookPayload, type AgentId } from '../contract'
import { createAgentStatusMachine, type AgentStatusChange, type AgentStatusMachine } from './status'

const PTY = 'pty-agent-status'
const SESSION = 'session-agent-status'

interface AgentLifecycleFixture {
  agentId: AgentId
  sessionStart: Record<string, unknown>
  turnStart: Record<string, unknown>
  turnEnd: Record<string, unknown>
}

interface PermissionFixture {
  agentId: AgentId
  turnStart: Record<string, unknown>
  permissionWait: Record<string, unknown>
}

const fixtures: AgentLifecycleFixture[] = [
  {
    agentId: 'claude-code',
    sessionStart: { hook_event_name: 'SessionStart', session_id: SESSION },
    turnStart: { hook_event_name: 'UserPromptSubmit', session_id: SESSION },
    turnEnd: { hook_event_name: 'Stop', session_id: SESSION },
  },
  {
    agentId: 'codex',
    sessionStart: { hook_event_name: 'SessionStart', session_id: SESSION },
    turnStart: { hook_event_name: 'UserPromptSubmit', session_id: SESSION },
    turnEnd: { hook_event_name: 'Stop', session_id: SESSION },
  },
  {
    agentId: 'cursor',
    sessionStart: { hook_event_name: 'sessionStart', session_id: SESSION, workspace_roots: ['/workspace'] },
    turnStart: { hook_event_name: 'beforeSubmitPrompt', session_id: SESSION, workspace_roots: ['/workspace'] },
    turnEnd: { hook_event_name: 'stop', session_id: SESSION, workspace_roots: ['/workspace'] },
  },
  {
    agentId: 'grok',
    sessionStart: { hookEventName: 'session_start', sessionId: SESSION },
    turnStart: { hookEventName: 'user_prompt_submit', sessionId: SESSION },
    turnEnd: { hookEventName: 'stop', sessionId: SESSION },
  },
  {
    agentId: 'hermes',
    sessionStart: { hook_event_name: 'on_session_start', session_id: SESSION, profile: 'default', platform: 'cli' },
    turnStart: { hook_event_name: 'pre_llm_call', session_id: SESSION, profile: 'default', platform: 'cli' },
    turnEnd: { hook_event_name: 'on_session_end', session_id: SESSION, profile: 'default', platform: 'cli' },
  },
  {
    agentId: 'opencode',
    sessionStart: { type: 'session.created', sessionID: SESSION },
    turnStart: { type: 'session.status', sessionID: SESSION, status: { type: 'busy' } },
    turnEnd: { type: 'session.status', sessionID: SESSION, status: { type: 'idle' } },
  },
  {
    agentId: 'kiro',
    sessionStart: { hook_event_name: 'agentSpawn', session_id: SESSION },
    turnStart: { hook_event_name: 'userPromptSubmit', session_id: SESSION },
    turnEnd: { hook_event_name: 'stop', session_id: SESSION },
  },
]

const permissionFixtures: PermissionFixture[] = [
  {
    agentId: 'claude-code',
    turnStart: { hook_event_name: 'UserPromptSubmit', session_id: SESSION },
    permissionWait: {
      hook_event_name: 'PermissionRequest',
      session_id: SESSION,
    },
  },
  {
    agentId: 'codex',
    turnStart: { hook_event_name: 'UserPromptSubmit', session_id: SESSION },
    permissionWait: {
      hook_event_name: 'PermissionRequest',
      session_id: SESSION,
      turn_id: 'turn-1',
      tool_name: 'Bash',
    },
  },
  {
    agentId: 'grok',
    turnStart: { hookEventName: 'user_prompt_submit', sessionId: SESSION },
    permissionWait: {
      hookEventName: 'notification',
      notificationType: 'permission_prompt',
      sessionId: SESSION,
    },
  },
  {
    agentId: 'hermes',
    turnStart: { hook_event_name: 'pre_llm_call', session_id: SESSION, profile: 'default', platform: 'cli' },
    permissionWait: {
      hook_event_name: 'pre_approval_request', session_id: SESSION, profile: 'default', platform: 'cli', surface: 'cli',
    },
  },
  {
    agentId: 'opencode',
    turnStart: { type: 'session.status', sessionID: SESSION, status: { type: 'busy' } },
    permissionWait: { type: 'permission.asked', sessionID: SESSION },
  },
]

let machine: AgentStatusMachine
/** Changes that reach the user (a notification). */
let attention: AgentStatusChange[]

function state(): string {
  return machine.status(PTY)
}

function emit(agentId: AgentId, raw: Record<string, unknown>): void {
  const event = normalizeAgentHookPayload(agentId, PTY, raw)
  expect(event, `${agentId} payload normalizes`).not.toBeNull()
  machine.noteHookEvent(event!)
}

describe('coding-agent hook status integration', () => {
  beforeEach(() => {
    attention = []
    machine = createAgentStatusMachine((change) => { if (change.attention) attention.push(change) })
    machine.notePresence(PTY, true, false, null)
  })

  it('covers every registered coding-agent CLI', () => {
    expect(fixtures.map((fixture) => fixture.agentId).sort()).toEqual(AGENTS.map((agent) => agent.id).sort())
  })

  it.each(fixtures)('$agentId remains stable across consecutive turns', ({
    agentId,
    sessionStart,
    turnStart,
    turnEnd,
  }) => {
    emit(agentId, sessionStart)
    expect(state()).toBe('waitingForInput')

    emit(agentId, turnStart)
    expect(state()).toBe('running')
    emit(agentId, turnEnd)
    expect(state()).toBe('waitingForInput')

    emit(agentId, turnStart)
    expect(state()).toBe('running')
    emit(agentId, turnEnd)
    expect(state()).toBe('waitingForInput')
  })

  it('codex does not let its deferred SessionStart overwrite the first running turn', () => {
    const codex = fixtures.find((fixture) => fixture.agentId === 'codex')!

    // Codex TUI defers SessionStart until the first submit. These two hook
    // posts are independent, so the coordinator must tolerate either arrival
    // order for the same session.
    emit(codex.agentId, codex.turnStart)
    expect(state()).toBe('running')
    emit(codex.agentId, codex.sessionStart)
    expect(state()).toBe('running')
  })

  it('codex resumes when an approved bash command starts', () => {
    emit('codex', { hook_event_name: 'UserPromptSubmit', session_id: SESSION, turn_id: 'turn-1' })
    emit('codex', {
      hook_event_name: 'PermissionRequest', session_id: SESSION, turn_id: 'turn-1', tool_name: 'Bash',
    })
    expect(state()).toBe('running')

    emit('codex', {
      hook_event_name: 'PreToolUse', session_id: SESSION, turn_id: 'turn-1', tool_name: 'Bash',
    })
    expect(state()).toBe('running')
  })

  it('claude-code resumes when an approved bash command starts', () => {
    emit('claude-code', { hook_event_name: 'UserPromptSubmit', session_id: SESSION })
    emit('claude-code', {
      hook_event_name: 'PermissionRequest', session_id: SESSION, tool_name: 'Bash',
    })
    expect(state()).toBe('running')

    emit('claude-code', {
      hook_event_name: 'PreToolUse', session_id: SESSION, tool_name: 'Bash',
    })
    expect(state()).toBe('running')
  })

  it.each(permissionFixtures)(
    '$agentId resumes as soon as the user submits a permission answer',
    ({ agentId, turnStart, permissionWait }) => {
      emit(agentId, turnStart)
      emit(agentId, permissionWait)
      expect(state()).toBe(agentId === 'codex' || agentId === 'claude-code' ? 'running' : 'waitingForInput')

      machine.noteHookEvent({ terminalId: PTY, agentId, kind: 'input-submit', sessionId: SESSION, raw: {} })
      expect(state()).toBe('running')
    },
  )

  it.each([
    { agentId: 'codex', hook_event_name: 'PermissionRequest' },
    { agentId: 'claude-code', hook_event_name: 'PermissionRequest' },
    { agentId: 'hermes', hook_event_name: 'pre_approval_request', surface: 'smart' },
    { agentId: 'hermes', hook_event_name: 'pre_approval_request', surface: 'transport:reviewer' },
    { agentId: 'hermes', hook_event_name: 'pre_approval_request' },
  ] as const)('$agentId ambiguous/automatic approvals never announce readiness ($surface)', (raw) => {
    const fixture = fixtures.find((f) => f.agentId === raw.agentId)!
    emit(raw.agentId, fixture.turnStart)
    for (let i = 0; i < 3; i++) {
      emit(raw.agentId, { ...raw, session_id: SESSION, profile: 'default', platform: 'cli' })
      machine.notePresence(PTY, true, false, null)
      expect(state()).toBe('running')
      expect(machine.canReceivePrompt(PTY)).toBe(false)
      expect(attention).toEqual([])
    }
    // Even a denial without a tool execution ends via the normal turn boundary.
    emit(raw.agentId, fixture.turnEnd)
    expect(state()).toBe('waitingForInput')
    expect(machine.canReceivePrompt(PTY)).toBe(true)
    expect(attention).toHaveLength(1)
  })

  it.each(['claude-code', 'hermes'] as const)('%s notifies only when a check escalates to a human', (agentId) => {
    const extra = { session_id: SESSION, profile: 'default', platform: 'cli' }
    emit(agentId, fixtures.find((f) => f.agentId === agentId)!.turnStart)
    const check = agentId === 'claude-code'
      ? { hook_event_name: 'PermissionRequest' }
      : { hook_event_name: 'pre_approval_request', surface: 'smart' }
    emit(agentId, { ...check, ...extra })
    expect(attention).toEqual([])
    const human = agentId === 'claude-code'
      ? { hook_event_name: 'Notification', notification_type: 'permission_prompt' }
      : { hook_event_name: 'pre_approval_request', surface: 'cli' }
    emit(agentId, { ...human, ...extra })
    expect(state()).toBe('waitingForInput')
    expect(machine.canReceivePrompt(PTY)).toBe(false)
    expect(attention).toHaveLength(1)
    expect(attention[0].attention?.permission).toBeDefined()
  })

  it.each(['PostToolUseFailure', 'PermissionDenied'])('Claude %s resumes silently after a permission check', (hook_event_name) => {
    emit('claude-code', { hook_event_name: 'PermissionRequest', session_id: SESSION })
    emit('claude-code', { hook_event_name, session_id: SESSION })
    expect(state()).toBe('running')
    expect(attention).toEqual([])
  })

  it.each(['codex', 'claude-code'] as const)('%s child hooks cannot mark the parent as ready', (agentId) => {
    emit(agentId, fixtures.find((f) => f.agentId === agentId)!.turnStart)
    for (const hook_event_name of ['SessionStart', 'PermissionRequest', 'Stop', 'SessionEnd']) {
      expect(normalizeAgentHookPayload(agentId, PTY, {
        hook_event_name, session_id: 'child-session', agent_id: 'child-agent',
      })).toBeNull()
    }
    expect(state()).toBe('running')
    expect(attention).toEqual([])
  })

  it.each(fixtures)('$agentId ignores a different session ending mid-turn', (fixture) => {
    emit(fixture.agentId, fixture.turnStart)
    emit(fixture.agentId, {
      ...fixture.turnEnd, session_id: 'previous', sessionId: 'previous', sessionID: 'previous',
    })
    expect(state()).toBe('running')
    expect(attention).toEqual([])
  })

  it.each([
    ['cursor', { hook_event_name: 'beforeShellExecution', command: 'echo ok' }],
    ['kiro', { hook_event_name: 'PreToolUse', tool_name: 'execute_bash' }],
    ['grok', { hookEventName: 'pre_tool_use', toolName: 'run_terminal_command' }],
    ['opencode', { type: 'tool.execute.before' }],
  ] as const)('%s ordinary tool checks never imply a human wait', (agentId, raw) => {
    emit(agentId, fixtures.find((f) => f.agentId === agentId)!.turnStart)
    expect(normalizeAgentHookPayload(agentId, PTY, raw)).toBeNull()
    expect(state()).toBe('running')
    expect(attention).toEqual([])
  })
})
