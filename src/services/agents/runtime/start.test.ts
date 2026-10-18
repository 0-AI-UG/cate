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
  worktrees: { create: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
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
      setRelationContextMode: () => {},
      setTitleFromAgent: () => {},
      onChange: () => () => {},
    },
    resolveCheckout: async (cwd) => cwd ?? root,
    snapshot: async () => ({ nameByPid: new Map(), childrenByPid: new Map() }),
    notify: () => {},
  }, () => ({
    state: () => null,
    panelIds: () => [],
    onChange: () => () => {},
    send: async () => ({ ok: true }),
    interrupt: async () => ({ ok: true }),
    conversation: async () => null,
    conversationStamp: async () => null,
    onStep: () => () => {},
    dispose: () => {},
  }))
  ports = {
    terminals: {
      create: vi.fn(async () => 'new-terminal'),
      relaunch: vi.fn(async () => {}),
      state: vi.fn((panelId: string) => (panelId === 'idle' ? { alive: true, busy: false } : null)),
    },
    worktrees: { create: vi.fn(async (name: string) => ({ id: `wt-${name}`, path: `/repo/.cate/worktrees/${name}` })), remove: vi.fn(async () => {}) },
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
    await expect(starter().start('supervisor', { prompt: '  Fix the login  ' })).resolves.toEqual({ panelId: 'new-terminal', agentId: 'codex' })
    expect(ports.terminals.create).toHaveBeenCalledWith({
      cwd: '/repo/.cate/worktrees/lead',
      worktreeId: 'wt-lead',
      title: 'Fix the login',
      launch: { kind: 'agents.start', params: { agentId: 'codex', prompt: 'Fix the login' } },
      placement: { near: 'supervisor' },
    })
  })

  it('opens the interactive session at a picked spot without a prompt, titled by the agent', async () => {
    const placement = { at: { to: 'canvas', canvasId: 'c', nodeId: 'n', layoutId: 'l', stackId: 's', rect: { origin: { x: 0, y: 0 }, size: { width: 640, height: 400 } } } } as const
    await starter().start(undefined, { agentId: 'codex', placement })
    expect(ports.terminals.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Codex',
      launch: { kind: 'agents.start', params: { agentId: 'codex' } },
      placement,
    }))
  })

  it('marks a title the caller chose, so the agent never retitles the panel', async () => {
    await starter().start('supervisor', { prompt: 'Fix the login', title: '  Alpha ' })
    expect(ports.terminals.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Alpha', titleChosen: true }))
  })

  it('counts a started agent as starting until its terminal stops or its CLI is observed', async () => {
    const agentStarter = starter()
    ports.terminals.state.mockReturnValue({ alive: true, busy: true })
    await agentStarter.start('supervisor', { prompt: 'Fix it' })
    expect(agentStarter.starting()).toEqual([{ panelId: 'new-terminal', agentId: 'codex' }])
    ports.terminals.state.mockReturnValue({ alive: false, busy: false })
    expect(agentStarter.starting()).toEqual([])
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

  it('lists every agent CLI with whether it can start here', async () => {
    const types = await starter().types()
    expect(types.map((type) => type.agentId)).toEqual(['claude-code', 'codex', 'cursor', 'grok', 'opencode', 'hermes', 'kiro'])
    expect(types.find((type) => type.agentId === 'codex')).toEqual({ agentId: 'codex', displayName: 'Codex', ready: true })
    expect(types.find((type) => type.agentId === 'kiro')).toMatchObject({ ready: false })
  })
})
