// Coverage for AgentManager.disposeForWebContents — the hook that drops every
// pi session owned by a window whose webContents went away (wired from
// ipcAgent's AGENT_CREATE 'destroyed' listener). Sessions are injected straight
// into the private map and dispose() is spied, so this exercises the
// sender-id filtering without spawning pi.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({}))
vi.mock('../../main/windowRegistry', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../main/runtime/runtimeManager', () => ({ runtimes: { resolve: vi.fn() } }))
vi.mock('../../main/runtime/locator', () => ({
  parseLocator: vi.fn(() => ({ runtimeId: 'local', path: '/ws' })),
}))
vi.mock('./piRpcClient', () => ({ PiRpcClient: vi.fn() }))
vi.mock('./installSubagents', () => ({ installSubagentExtension: vi.fn() }))
vi.mock('./installPlanMode', () => ({ installPlanModeExtension: vi.fn() }))
vi.mock('./installAskUser', () => ({ installAskUserExtension: vi.fn() }))
vi.mock('./agentDir', () => ({
  hostAgentDir: vi.fn(() => '/agent'),
  prepareAgentDir: vi.fn(),
  watchWorkspaceAuth: vi.fn(),
  pushSharedToWorkspace: vi.fn(),
}))
vi.mock('./customModels', () => ({ mirrorModelsToWorkspace: vi.fn() }))

import { AgentManager } from './agentManager'
import type { AuthManager } from './authManager'

const fakeAuthManager = { setOnChange: vi.fn() } as unknown as AuthManager

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
