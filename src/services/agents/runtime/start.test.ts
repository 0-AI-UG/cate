import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRpcError } from '@kernel/rpc/contract'
import type { PanelRecord } from '@workspace/document/contract'
import type { AgentHookConfig } from '../contract'
import { createAgentsCore, type AgentsCore } from './core'
import { createAgentStarter, type AgentStartPorts } from './start'


let root: string
let agents: AgentsCore
let hookConfig: AgentHookConfig
let ports: {
  terminals: { create: ReturnType<typeof vi.fn>; relaunch: ReturnType<typeof vi.fn>; state: ReturnType<typeof vi.fn> }
  createChat: ReturnType<typeof vi.fn>
  worktrees: { create: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
  t3: { providerModels: ReturnType<typeof vi.fn>; startThread: ReturnType<typeof vi.fn>; stopThread: ReturnType<typeof vi.fn> }
}

const panels: PanelRecord[] = [
  { id: 'supervisor', type: 'terminal', title: 'Lead', worktreeId: 'wt-lead', fields: {} },
  { id: 'idle', type: 'terminal', title: 'Idle', fields: {} },
]
const worktrees: Record<string, string> = { 'wt-lead': '/repo/.cate/worktrees/lead' }

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'cate-agent-start-'))
  hookConfig = { codex: 'on' }
  agents = createAgentsCore({
    root,
    agentsDir: path.join(root, '.agents-data'),
    trust: { isTrusted: () => true, requireTrusted: () => {} },
    settings: { agentHookInjection: () => hookConfig, panelRelationsEnabled: () => true },
    relationRole: () => undefined,
    document: {
      panel: (id) => panels.find((panel) => panel.id === id),
      panels: () => panels,
      relations: () => [],
      worktreePath: (id) => worktrees[id],
      relationContextMode: () => 'once',
      setRelationContextMode: () => {},
      setTitleFromAgent: () => {},
      onChange: () => () => {},
    },
    resolveCheckout: async (cwd) => cwd ?? root,
    snapshot: async () => ({ nameByPid: new Map(), childrenByPid: new Map() }),
    notify: () => {},
    watchStatus: () => () => {},
  })
  ports = {
    terminals: {
      create: vi.fn(async () => 'new-terminal'),
      relaunch: vi.fn(async () => {}),
      state: vi.fn((panelId: string) => (panelId === 'idle' ? { alive: true, busy: false } : null)),
    },
    createChat: vi.fn(() => 'new-chat'),
    worktrees: { create: vi.fn(async (name: string) => ({ id: `wt-${name}`, path: `/repo/.cate/worktrees/${name}` })), remove: vi.fn(async () => {}) },
    t3: {
      providerModels: vi.fn(async () => [
        { providerId: 'claude', instanceId: 'claude-1', label: 'Claude', ready: true, models: [{ slug: 'opus', name: 'Opus', isDefault: true }] },
        { providerId: 'codex', instanceId: 'codex-off', label: 'Codex', ready: false, models: [{ slug: 'gpt', name: 'GPT', isDefault: true }] },
        { providerId: 'codex', instanceId: 'codex-1', label: 'Codex', ready: true, models: [{ slug: 'mini', name: 'Mini', isDefault: false }, { slug: 'gpt', name: 'GPT', isDefault: true }] },
      ]),
      startThread: vi.fn(async () => ({ threadId: 'thread-1' })),
      stopThread: vi.fn(async () => {}),
    },
  }
})

afterEach(() => {
  agents.dispose()
  rmSync(root, { recursive: true, force: true })
})

const starter = () => createAgentStarter(agents, ports as unknown as AgentStartPorts)

async function refusal(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (error) {
    expect(isRpcError(error)).toBe(true)
    return (error as Error).message
  }
  throw new Error('expected a refusal')
}

describe('agent start', () => {
  it('runs a hook-ready CLI in a terminal next to the caller, in its checkout', async () => {
    await expect(starter().start('supervisor', { prompt: '  Fix the login  ' })).resolves.toEqual({ panelId: 'new-terminal', runner: 'terminal', agentId: 'codex' })
    expect(ports.terminals.create).toHaveBeenCalledWith({
      cwd: '/repo/.cate/worktrees/lead',
      worktreeId: 'wt-lead',
      title: 'Fix the login',
      launch: { kind: 'agents.start', params: { agentId: 'codex', prompt: 'Fix the login' } },
      placement: { near: 'supervisor' },
    })
  })

  it('runs a client\'s start in a new worktree where it asks', async () => {
    const placement = { near: 'canvas', position: { x: 1, y: 2 } }
    await starter().start(undefined, { prompt: 'Fix it', agentId: 'codex', newWorktree: 'fix', placement })
    expect(ports.worktrees.create).toHaveBeenCalledWith('fix')
    expect(ports.terminals.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo/.cate/worktrees/fix', worktreeId: 'wt-fix', placement }))
  })

  it('removes the worktree it created when the panel cannot start', async () => {
    ports.terminals.create.mockRejectedValueOnce(new Error('could not place the terminal'))
    await expect(starter().start(undefined, { prompt: 'Fix it', newWorktree: 'fix' })).rejects.toThrow('could not place the terminal')
    expect(ports.worktrees.remove).toHaveBeenCalledWith('wt-fix')
  })

  it('fails when relaunching the reused terminal fails', async () => {
    ports.terminals.relaunch.mockRejectedValueOnce(new Error('spawn failed'))
    await expect(starter().start(undefined, { prompt: 'Fix it', terminalPanelId: 'idle' })).rejects.toThrow('spawn failed')
  })

  it('stops the thread it started when its chat cannot be made, before removing the worktree', async () => {
    const order: string[] = []
    ports.createChat.mockImplementationOnce(() => { throw new Error('no place for the chat') })
    ports.t3.stopThread.mockImplementation(async () => { order.push('stop thread') })
    ports.worktrees.remove.mockImplementation(async () => { order.push('remove worktree') })
    await expect(starter().start(undefined, { prompt: 'Fix it', runner: 't3', newWorktree: 'fix' })).rejects.toThrow('no place for the chat')
    expect(ports.t3.stopThread).toHaveBeenCalledWith({ checkout: '/repo/.cate/worktrees/fix', threadId: 'thread-1' })
    expect(order).toEqual(['stop thread', 'remove worktree'])
  })

  it('refuses before creating anything when the CLI cannot start', async () => {
    await expect(refusal(starter().start(undefined, { prompt: 'Fix it', agentId: 'kiro', newWorktree: 'fix' }))).resolves.toMatch(/^agent-hooks-not-ready/)
    await expect(refusal(starter().start(undefined, { prompt: 'Fix it', agentId: 'nope' }))).resolves.toBe('unsupported-agent')
    await expect(refusal(starter().start(undefined, { prompt: '   ' }))).resolves.toBe('prompt-required')
    expect(ports.worktrees.create).not.toHaveBeenCalled()
    expect(ports.terminals.create).not.toHaveBeenCalled()
  })

  it('reuses an idle terminal, and refuses a busy one', async () => {
    await expect(starter().start('supervisor', { prompt: 'Review', terminalPanelId: 'idle' })).resolves.toMatchObject({ panelId: 'idle' })
    expect(ports.terminals.relaunch).toHaveBeenCalledWith('idle', expect.objectContaining({ launch: expect.objectContaining({ kind: 'agents.start' }) }))
    ports.terminals.state.mockReturnValue({ alive: true, busy: true })
    await expect(refusal(starter().start('supervisor', { prompt: 'Review', terminalPanelId: 'idle' }))).resolves.toBe('terminal-busy')
  })

  it('starts a T3 chat on a ready instance of the agent\'s provider and its default model', async () => {
    await expect(starter().start(undefined, { prompt: 'Fix it', runner: 't3', agentId: 'codex' })).resolves.toEqual({ panelId: 'new-chat', runner: 't3', agentId: 'codex' })
    expect(ports.t3.startThread).toHaveBeenCalledWith({ instanceId: 'codex-1', model: 'gpt', text: 'Fix it' })
    expect(ports.createChat).toHaveBeenCalledWith({ threadId: 'thread-1', placement: {} })
  })

  it('starts a T3 chat on the instance and model asked for, in its worktree', async () => {
    await starter().start('supervisor', { prompt: 'Fix it', runner: 't3', instanceId: 'codex-1', model: 'mini' })
    expect(ports.t3.startThread).toHaveBeenCalledWith({ checkout: '/repo/.cate/worktrees/lead', instanceId: 'codex-1', model: 'mini', text: 'Fix it' })
    expect(ports.createChat).toHaveBeenCalledWith({
      threadId: 'thread-1', cwd: '/repo/.cate/worktrees/lead', worktreeId: 'wt-lead', placement: { near: 'supervisor' },
    })
    await expect(refusal(starter().start(undefined, { prompt: 'Fix it', runner: 't3', agentId: 'kiro' }))).resolves.toBe('agent-not-in-t3')
  })

  it('lists every agent CLI with whether it can start here', async () => {
    const types = await starter().types()
    expect(types.map((type) => type.agentId)).toEqual(['claude-code', 'codex', 'cursor', 'grok', 'opencode', 'hermes', 'kiro'])
    expect(types.find((type) => type.agentId === 'codex')).toEqual({ agentId: 'codex', displayName: 'Codex', ready: true, t3Provider: 'codex' })
    expect(types.find((type) => type.agentId === 'kiro')).toMatchObject({ ready: false, t3Provider: null })
  })
})
