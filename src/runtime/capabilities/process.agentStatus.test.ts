// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentHooksCapability } from './agentHooks'
import { createProcessCapability } from './process'
import { AGENTS } from '../../shared/agents'
import type { AgentHookEvent } from '../../shared/agentHooks'
import {
  noteAgentHookEvent, noteAgentPresence, startAgentScreenDetector, stopAgentScreenDetector,
} from '../../renderer/lib/agent/agentScreenDetector'
import { setTerminalWorkspaceResolver, useStatusStore } from '../../renderer/stores/statusStore'

vi.mock('../../renderer/lib/notifications/osNotificationSend', () => ({ sendOsNotification: vi.fn() }))
const pty = vi.hoisted(() => ({
  pid: 2147483647, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn(),
}))
vi.mock('node-pty', () => ({ spawn: () => pty }))

const fixtures = [
  { agentId: 'codex', start: { hook_event_name: 'UserPromptSubmit' }, wait: { hook_event_name: 'PermissionRequest' } },
  { agentId: 'claude-code', start: { hook_event_name: 'UserPromptSubmit' }, wait: { hook_event_name: 'PermissionRequest' } },
  { agentId: 'grok', start: { hookEventName: 'user_prompt_submit' }, wait: { hookEventName: 'notification', notificationType: 'permission_prompt' } },
  { agentId: 'opencode', start: { type: 'session.status', status: { type: 'busy' } }, wait: { type: 'permission.asked' } },
  // These CLIs have no permission-wait hook. Input must preserve their running state.
  { agentId: 'cursor', start: { hook_event_name: 'beforeSubmitPrompt' }, wait: null },
  { agentId: 'kiro', start: { hook_event_name: 'UserPromptSubmit' }, wait: null },
] as const

const terminalId = 'pty-status'
const workspaceId = 'ws-status'
let cleanup: () => void

beforeEach(() => {
  vi.clearAllMocks()
  useStatusStore.setState({ workspaces: {} })
  setTerminalWorkspaceResolver((id) => id === terminalId ? workspaceId : undefined)
  useStatusStore.getState().registerTerminal(terminalId, workspaceId)
  window.electronAPI = { shellReportAgentScreenState: vi.fn() } as unknown as typeof window.electronAPI
  startAgentScreenDetector()
  noteAgentPresence(terminalId, true)
})
afterEach(() => {
  cleanup?.()
  stopAgentScreenDetector()
})

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cate-status-regression-'))
  const hooks = createAgentHooksCapability({ hooksDir: dir, homeDir: dir })
  const process = createProcessCapability({
    resolveShell: () => ({ path: '/bin/sh', args: [] }), getEnv: () => ({}), hooks,
  })
  cleanup = () => {
    process.kill(terminalId)
    hooks.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
  await process.create({ id: terminalId, cols: 80, rows: 24, cwd: dir }, () => {}, () => {})
  const endpoint = await hooks.endpoint()
  const queued: AgentHookEvent[] = []
  hooks.subscribe((event) => queued.push(event))
  const flush = () => { for (const event of queued.splice(0)) noteAgentHookEvent(event) }
  const post = async (agentId: string, payload: Record<string, unknown>) => {
    const response = await fetch(`${endpoint.url}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.tokenFor(terminalId)}` },
      body: JSON.stringify({ agentId, terminalId, payload: {
        session_id: 'session', sessionId: 'session', sessionID: 'session', ...payload,
      } }),
    })
    expect(response.status).toBe(204)
  }
  return { process, queued, flush, post }
}

function state() {
  return useStatusStore.getState().workspaces[workspaceId]?.terminals[terminalId]?.agentState
}

describe('PTY input and agent hooks share an ordered status stream', () => {
  it('covers every CLI agent', () => {
    expect(fixtures.map(f => f.agentId).sort()).toEqual(AGENTS.map(a => a.id).sort())
  })

  for (const delayedRenderer of [false, true]) {
    it.each(fixtures)(`$agentId stays running after approval (delayed renderer: ${delayedRenderer})`, async ({ agentId, start, wait }) => {
      const { process, post, flush, queued } = await setup()
      await post(agentId, start)
      flush()
      expect(state()).toBe('running')
      if (wait) await post(agentId, wait)
      if (!delayedRenderer) {
        flush()
        expect(state()).toBe(wait ? 'waitingForInput' : 'running')
      }
      // The common runtime write is used by physical keys AND cate.terminal.press.
      // Delaying delivery reproduces approval arriving before the renderer sees the wait.
      process.write(terminalId, '\r')
      expect(pty.write).toHaveBeenCalledWith('\r')
      flush()
      expect(state()).toBe('running')
      noteAgentPresence(terminalId, true)
      expect(state()).toBe('running') // no PostToolUse; the command is still executing
      expect(queued).toEqual([])
    })
  }

  it('does not resume for typing, navigation, failed writes, or a different terminal', async () => {
    const { process, post, flush, queued } = await setup()
    await post('codex', { hook_event_name: 'UserPromptSubmit' })
    await post('codex', { hook_event_name: 'PermissionRequest' })
    flush()
    process.write(terminalId, 'some text')
    process.write(terminalId, '\x1b[B')
    process.write('other-terminal', '\r')
    pty.write.mockImplementationOnce(() => { throw new Error('closed') })
    process.write(terminalId, '\r')
    expect(queued).toEqual([])
    flush()
    expect(state()).toBe('waitingForInput')
  })

  it('never forwards typed text and does not turn an idle agent into running', async () => {
    const { process, post, flush, queued } = await setup()
    process.write(terminalId, '\r')
    expect(queued).toEqual([]) // no agent has identified this terminal
    await post('codex', { hook_event_name: 'SessionStart' })
    flush()
    process.write(terminalId, 'private input\r')
    expect(queued).toEqual([{
      terminalId, agentId: 'codex', sessionId: 'session', kind: 'input-submit', raw: {},
    }])
    flush()
    expect(state()).toBe('waitingForInput')
  })

  it.each(['exit', 'kill'] as const)('forgets the agent when the PTY is removed by %s', async (reason) => {
    const { process, post, flush, queued } = await setup()
    await post('codex', { hook_event_name: 'UserPromptSubmit' })
    await post('codex', { hook_event_name: 'PermissionRequest' })
    flush()
    if (reason === 'kill') process.kill(terminalId)
    else pty.onExit.mock.calls[0][0]({ exitCode: 0 })
    // Reuse the id for a fresh shell. It must prove agent identity again.
    await process.create({ id: terminalId, cols: 80, rows: 24, cwd: tmpdir() }, () => {}, () => {})
    process.write(terminalId, '\r')
    expect(queued).toEqual([])
  })

  it('preserves Kiro Ctrl-C recovery through automated PTY input', async () => {
    const { process, post, flush } = await setup()
    await post('kiro', { hook_event_name: 'UserPromptSubmit' })
    flush()
    expect(state()).toBe('running')
    process.write(terminalId, '\x03')
    flush()
    expect(state()).toBe('waitingForInput')
  })
})
