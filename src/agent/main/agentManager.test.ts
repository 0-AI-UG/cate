// Coverage for AgentManager.disposeForWebContents — the hook that drops every
// pi session owned by a window whose webContents went away (wired from
// ipcAgent's AGENT_CREATE 'destroyed' listener). Sessions are injected straight
// into the private map and dispose() is spied, so this exercises the
// sender-id filtering without spawning pi.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({}))
vi.mock('../../main/windowRegistry', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../main/windowPanels', () => ({ getWindowPanels: () => [] }))
vi.mock('../../main/runtime/runtimeManager', () => ({ runtimes: { resolve: vi.fn() } }))
vi.mock('../../main/runtime/locator', () => ({
  parseLocator: vi.fn((path: string) => ({ runtimeId: 'local', path })),
  formatLocator: vi.fn(({ path }: { path: string }) => path),
}))
vi.mock('./piRpcClient', () => ({ PiRpcClient: vi.fn() }))
vi.mock('./installSubagents', () => ({ installSubagentExtension: vi.fn() }))
vi.mock('./installPlanMode', () => ({ installPlanModeExtension: vi.fn() }))
vi.mock('./installAskUser', () => ({ installAskUserExtension: vi.fn() }))
vi.mock('./installMcpAdapter', () => ({ installMcpAdapter: vi.fn() }))
vi.mock('./agentDir', () => ({
  hostAgentDir: vi.fn(() => '/agent'),
  prepareAgentDir: vi.fn(),
  watchWorkspaceAuth: vi.fn(),
  pushSharedToWorkspace: vi.fn(),
  // Pulled in transitively (workspaceManager → seedCateCliSkill → skills targets).
  PI_AGENT_DIR: 'pi-agent',
  hostJoin: vi.fn((_rt: string, ...segs: string[]) => segs.join('/')),
}))
vi.mock('./customModels', () => ({ mirrorModelsToWorkspace: vi.fn() }))
vi.mock('../../skills/main/skillsMirror', () => ({ syncWorkspaceSkills: vi.fn() }))
vi.mock('../../main/extensions/workspaceCateApi', () => ({
  workspaceCateApi: { ensureEndpoint: vi.fn().mockResolvedValue(null) },
}))
vi.mock('../../main/workspaceStateStore', () => ({ isProjectTrusted: vi.fn(() => false) }))

import { AgentManager } from './agentManager'
import type { AuthManager } from './authManager'
import { runtimes } from '../../main/runtime/runtimeManager'
import { PiRpcClient } from './piRpcClient'
import { prepareAgentDir } from './agentDir'
import { syncWorkspaceSkills } from '../../skills/main/skillsMirror'

const fakeAuthManager = { setOnChange: vi.fn() } as unknown as AuthManager

describe('AgentManager worktree skill preparation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('mirrors base-workspace skills before preparing and starting a worktree agent', async () => {
    const runtime = { agent: { ensurePi: vi.fn().mockResolvedValue(undefined) } }
    vi.mocked(runtimes.resolve).mockReturnValue(runtime as never)
    const client = {
      start: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
    }
    vi.mocked(PiRpcClient).mockImplementation(() => client as never)
    vi.mocked(syncWorkspaceSkills).mockResolvedValue({
      copied: [],
      updated: [],
      removed: [],
      preserved: [],
      warnings: [],
    })

    const manager = new AgentManager(fakeAuthManager)
    await manager.create(
      {
        panelId: 'panel-worktree',
        workspaceId: 'workspace-1',
        workspaceRoot: '/repo/base',
        cwd: '/repo/worktree',
      },
      { id: 4, isDestroyed: () => false, send: vi.fn() } as never,
    )

    expect(syncWorkspaceSkills).toHaveBeenCalledWith('/repo/base', '/repo/worktree')
    expect(vi.mocked(syncWorkspaceSkills).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(prepareAgentDir).mock.invocationCallOrder[0],
    )
    expect(client.start).toHaveBeenCalledOnce()
  })
})

function makeManager() {
  const mgr = new AgentManager(fakeAuthManager)
  const disposed: string[] = []
  // dispose() runs through withLock + disposeInternal; stub it so we assert
  // exactly which panels were targeted without touching real pi clients.
  vi.spyOn(mgr, 'dispose').mockImplementation(async (panelId: string) => {
    disposed.push(panelId)
  })
  // Inject sessions with only the fields disposeForWebContents reads.
  const sessions = (mgr as unknown as { sessions: Map<string, { sender: { id: number } }> }).sessions
  const inject = (panelId: string, senderId: number) =>
    sessions.set(panelId, { sender: { id: senderId } })
  return { mgr, disposed, inject }
}

describe('AgentManager.disposeForWebContents', () => {
  beforeEach(() => vi.clearAllMocks())

  it('disposes only sessions owned by the destroyed webContents', () => {
    const { mgr, disposed, inject } = makeManager()
    inject('a', 1)
    inject('b', 1)
    inject('c', 2)

    mgr.disposeForWebContents(1)

    expect(disposed.sort()).toEqual(['a', 'b'])
  })

  it('is a no-op when no session matches the webContents id', () => {
    const { mgr, disposed, inject } = makeManager()
    inject('a', 1)

    mgr.disposeForWebContents(99)

    expect(disposed).toEqual([])
  })

  it('leaves other windows sessions intact', () => {
    const { mgr, disposed, inject } = makeManager()
    inject('a', 1)
    inject('b', 2)
    inject('c', 2)

    mgr.disposeForWebContents(2)

    expect(disposed.sort()).toEqual(['b', 'c'])
  })
})

// runTurn is the non-streaming extension turn runner: it resolves with the final
// assistant message read straight off the terminal `agent_end` event's `messages`.
// The tricky case is pi's auto-retry: it emits an `agent_end` with willRetry:true
// for the failed turn (whose last assistant message is an empty error) before the
// real terminal one. Resolving on the first agent_end is what produced "(no text)".
describe('AgentManager.runTurn', () => {
  beforeEach(() => vi.clearAllMocks())

  function fakeClient() {
    let eventListener: ((ev: unknown) => void) | undefined
    return {
      emit: (ev: unknown) => eventListener?.(ev),
      onEvent: (l: (ev: unknown) => void) => { eventListener = l; return () => {} },
      onExit: () => () => {},
      prompt: vi.fn(async () => {}),
    }
  }

  const run = (client: unknown) =>
    (new AgentManager(fakeAuthManager) as unknown as {
      runTurn(s: unknown, t: string): Promise<{ text: string; message: unknown }>
    }).runTurn({ client }, 'hi')

  const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })
  const toolOnly = { role: 'assistant', content: [{ type: 'toolCall', name: 'x' }] }

  it('skips a willRetry agent_end and resolves on the terminal one', async () => {
    const client = fakeClient()
    const result = run(client)

    // Failed turn: pi will retry, so this carries the empty error message.
    client.emit({ type: 'agent_end', willRetry: true, messages: [assistant('')] })
    // Retry succeeds.
    const answer = assistant('the answer')
    client.emit({ type: 'agent_end', willRetry: false, messages: [answer] })

    expect(await result).toEqual({ text: 'the answer', message: answer })
  })

  it('returns the answer-bearing assistant message, scanning past a tool-only turn', async () => {
    const client = fakeClient()
    const result = run(client)

    // Final turn is a tool call with no text — text and message both come from
    // the real answer turn so they agree.
    const answer = assistant('real answer')
    client.emit({ type: 'agent_end', messages: [answer, toolOnly] })

    expect(await result).toEqual({ text: 'real answer', message: answer })
  })

  it('returns empty text but still the raw message when no turn carries text', async () => {
    const client = fakeClient()
    const result = run(client)

    client.emit({ type: 'agent_end', messages: [toolOnly] })

    expect(await result).toEqual({ text: '', message: toolOnly })
  })

  it('rejects with the reason when the turn ends on stopReason error', async () => {
    const client = fakeClient()
    const result = run(client)

    // pi surfaces an unsupported-model/auth failure as an empty assistant message
    // with stopReason 'error' — must reject, not resolve to silent empty text.
    client.emit({
      type: 'agent_end',
      willRetry: false,
      messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'model not supported' }],
    })

    await expect(result).rejects.toThrow('model not supported')
  })
})

// openForExtension keys extSessions by pi's session-file handle. Because a
// workspace's .cate/pi-agent dir is SHARED across all its extensions, extension
// B could pass extension A's LIVE handle as `resume` and silently overwrite A's
// routing entry — stranding A's pi child in `sessions` (leak) and forking two
// extensions onto one jsonl. The open must refuse a handle already owned by a
// different extension.
describe('AgentManager.openForExtension session ownership', () => {
  beforeEach(() => vi.clearAllMocks())

  function makeExtManager() {
    const mgr = new AgentManager(fakeAuthManager)
    const sessions = (mgr as unknown as { sessions: Map<string, unknown> }).sessions
    // Stub create so opening injects a fake pi session for the panel without
    // spawning anything; the client just echoes back a session-file path.
    vi.spyOn(
      mgr as unknown as { create: (o: { panelId: string; sessionFile?: string }, s: unknown) => Promise<void> },
      'create',
    ).mockImplementation(async (opts) => {
      sessions.set(opts.panelId, {
        panelId: opts.panelId,
        sender: { id: 1 },
        client: { getState: async () => ({ sessionFile: opts.sessionFile ?? `fresh-${opts.panelId}` }) },
      })
    })
    vi.spyOn(
      mgr as unknown as { resolveDefaultModel: () => Promise<null> },
      'resolveDefaultModel',
    ).mockResolvedValue(null)
    const extSessions = (mgr as unknown as {
      extSessions: Map<string, { extensionId: string; panelId: string; handle: string }>
    }).extSessions
    return { mgr, sessions, extSessions }
  }

  const openOpts = (extensionId: string, resume?: string) => ({
    workspaceId: 'ws',
    locator: 'local:/ws',
    extensionId,
    sender: { id: 1 } as never,
    resume,
  })

  it('rejects an extension resuming a handle owned by a different extension', async () => {
    const { mgr, sessions, extSessions } = makeExtManager()

    // Extension A opens and owns handle H (its own session file).
    const { sessionId: H } = await mgr.openForExtension(openOpts('ext-a', '/ws/.cate/pi-agent/H.jsonl'))
    const aPanel = extSessions.get(H)!.panelId
    expect(extSessions.get(H)!.extensionId).toBe('ext-a')

    // Extension B tries to resume A's live handle — must be refused, not overwrite.
    await expect(mgr.openForExtension(openOpts('ext-b', H))).rejects.toThrow(
      'session-owned-by-another-extension',
    )

    // A's routing survived unchanged and B did not strand a leaked pi session.
    expect(extSessions.get(H)!.extensionId).toBe('ext-a')
    expect(extSessions.get(H)!.panelId).toBe(aPanel)
    expect(sessions.has(aPanel)).toBe(true)
    expect(sessions.size).toBe(1)
  })

  it('still lets the same extension re-open its own live handle path', async () => {
    const { mgr, extSessions } = makeExtManager()

    const { sessionId: H } = await mgr.openForExtension(openOpts('ext-a', '/ws/.cate/pi-agent/H.jsonl'))
    // The same extension re-opening while its session is live hits the
    // one-live-session-per-extension cap (agent-busy), never the ownership guard.
    await expect(mgr.openForExtension(openOpts('ext-a', H))).rejects.toThrow('agent-busy')
    expect(extSessions.get(H)!.extensionId).toBe('ext-a')
  })
})
