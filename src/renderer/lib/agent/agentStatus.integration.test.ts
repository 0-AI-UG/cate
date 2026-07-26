// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAgentHookPayload } from '../../../shared/agentHooks'
import { AGENTS, type AgentId } from '../../../shared/agents'
import {
  noteAgentHookEvent,
  noteAgentInputSubmitted,
  noteAgentPresence,
  startAgentScreenDetector,
  stopAgentScreenDetector,
} from './agentScreenDetector'
import { setTerminalWorkspaceResolver, useStatusStore } from '../../stores/statusStore'

vi.mock('../notifications/osNotificationSend', () => ({ sendOsNotification: vi.fn() }))

const WS = 'ws-agent-status'
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
    agentId: 'pi',
    sessionStart: { event: 'session_start', sessionId: SESSION },
    turnStart: { event: 'agent_start', sessionId: SESSION },
    turnEnd: { event: 'agent_end', sessionId: SESSION },
  },
  {
    agentId: 'opencode',
    sessionStart: { type: 'session.created', sessionID: SESSION },
    turnStart: { type: 'session.status', sessionID: SESSION, status: { type: 'busy' } },
    turnEnd: { type: 'session.idle', sessionID: SESSION },
  },
]

const permissionFixtures: PermissionFixture[] = [
  {
    agentId: 'claude-code',
    turnStart: { hook_event_name: 'UserPromptSubmit', session_id: SESSION },
    permissionWait: {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
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
    agentId: 'opencode',
    turnStart: { type: 'session.status', sessionID: SESSION, status: { type: 'busy' } },
    permissionWait: { type: 'permission.asked', sessionID: SESSION },
  },
]

function state(): string | undefined {
  return useStatusStore.getState().workspaces[WS]?.terminals[PTY]?.agentState
}

function emit(agentId: AgentId, raw: Record<string, unknown>): void {
  const event = normalizeAgentHookPayload(agentId, PTY, raw)
  expect(event, `${agentId} payload normalizes`).not.toBeNull()
  noteAgentHookEvent(event!)
}

describe('coding-agent hook status integration', () => {
  beforeEach(() => {
    useStatusStore.setState({ workspaces: {} })
    setTerminalWorkspaceResolver((ptyId) => (ptyId === PTY ? WS : undefined))
    useStatusStore.getState().registerTerminal(PTY, WS)
    useStatusStore.getState().setAgentName(WS, PTY, 'Agent')
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      shellReportAgentScreenState: vi.fn(),
    }
    startAgentScreenDetector()
    noteAgentPresence(PTY, true)
  })

  afterEach(() => {
    stopAgentScreenDetector()
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

  it.each(permissionFixtures)(
    '$agentId resumes as soon as the user submits a permission answer',
    ({ agentId, turnStart, permissionWait }) => {
      emit(agentId, turnStart)
      emit(agentId, permissionWait)
      expect(state()).toBe('waitingForInput')

      noteAgentInputSubmitted(PTY)
      expect(state()).toBe('running')
    },
  )
})
