import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: FakeSender }, ...args: unknown[]) => unknown

interface FakeSender {
  id: number
  once: ReturnType<typeof vi.fn>
}

const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  listeners: new Map<string, Handler>(),
  shellOpenPath: vi.fn(),
  sendEvent: vi.fn(),
  listSessions: vi.fn(),
  loadSessionTranscript: vi.fn(),
  deleteSession: vi.fn(),
  readCustomOpenAIProviders: vi.fn(),
  saveCustomOpenAIProvider: vi.fn(),
  deleteCustomOpenAIProvider: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  ipcMain: {
    handle: (channel: string, handler: Handler) => h.handlers.set(channel, handler),
    on: (channel: string, handler: Handler) => h.listeners.set(channel, handler),
  },
  shell: { openPath: h.shellOpenPath },
}))
vi.mock('../../main/analytics', () => ({ sendEvent: h.sendEvent }))
vi.mock('./sessionFiles', () => ({
  listSessions: h.listSessions,
  loadSessionTranscript: h.loadSessionTranscript,
  deleteSession: h.deleteSession,
}))
vi.mock('../../main/runtime/runtimeManager', () => ({
  runtimes: { resolve: vi.fn() },
}))
vi.mock('./customModels', () => ({
  readCustomOpenAIProviders: h.readCustomOpenAIProviders,
  saveCustomOpenAIProvider: h.saveCustomOpenAIProvider,
  deleteCustomOpenAIProvider: h.deleteCustomOpenAIProvider,
}))

import { registerAgentHandlers } from './ipcAgent'
import {
  AGENT_CREATE,
  AGENT_CUSTOM_MODELS_DELETE,
  AGENT_CUSTOM_MODELS_GET,
  AGENT_CUSTOM_MODELS_SAVE,
  AGENT_DELETE_SESSION,
  AGENT_LIST_SESSIONS,
  AGENT_LOAD_SESSION_MESSAGES,
  AGENT_PROMPT,
} from '../../shared/ipc-channels'
import type { AgentManager } from './agentManager'
import type { AuthManager } from './authManager'

function makeManager(): AgentManager {
  return {
    create: vi.fn(async () => {}),
    disposeForWebContents: vi.fn(),
    prompt: vi.fn(async () => {}),
  } as unknown as AgentManager
}

function makeSender(id: number): { sender: FakeSender; destroy: () => void } {
  let destroyed: (() => void) | undefined
  const sender: FakeSender = {
    id,
    once: vi.fn((event: string, callback: () => void) => {
      if (event === 'destroyed') destroyed = callback
    }),
  }
  return { sender, destroy: () => destroyed?.() }
}

function invoke(channel: string, sender: FakeSender, ...args: unknown[]): unknown {
  const handler = h.handlers.get(channel)
  if (!handler) throw new Error(`No handler registered for ${channel}`)
  return handler({ sender }, ...args)
}

beforeEach(() => {
  h.handlers.clear()
  h.listeners.clear()
  h.sendEvent.mockReset()
  h.listSessions.mockReset()
  h.loadSessionTranscript.mockReset()
  h.deleteSession.mockReset()
  h.readCustomOpenAIProviders.mockReset()
  h.saveCustomOpenAIProvider.mockReset()
  h.deleteCustomOpenAIProvider.mockReset()
})

describe('agent IPC ownership and session routing', () => {
  it('hooks each owner window once and disposes all of its sessions when destroyed', async () => {
    const manager = makeManager()
    registerAgentHandlers({} as AuthManager, manager)
    const owner = makeSender(42)

    await expect(invoke(AGENT_CREATE, owner.sender, { panelId: 'one', cwd: '/work' })).resolves.toEqual({ ok: true })
    await expect(invoke(AGENT_CREATE, owner.sender, { panelId: 'two', cwd: '/work' })).resolves.toEqual({ ok: true })

    expect(owner.sender.once).toHaveBeenCalledTimes(1)
    expect(owner.sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function))
    expect(manager.create).toHaveBeenCalledTimes(2)

    owner.destroy()
    expect(manager.disposeForWebContents).toHaveBeenCalledOnce()
    expect(manager.disposeForWebContents).toHaveBeenCalledWith(42)
  })

  it('releases destroyed sender ids so a replacement sender with the same id gets cleanup ownership', async () => {
    const manager = makeManager()
    registerAgentHandlers({} as AuthManager, manager)
    const first = makeSender(7)
    await invoke(AGENT_CREATE, first.sender, { panelId: 'first', cwd: '/work' })
    first.destroy()

    const replacement = makeSender(7)
    await invoke(AGENT_CREATE, replacement.sender, { panelId: 'replacement', cwd: '/work' })

    expect(replacement.sender.once).toHaveBeenCalledOnce()
    replacement.destroy()
    expect(manager.disposeForWebContents).toHaveBeenNthCalledWith(1, 7)
    expect(manager.disposeForWebContents).toHaveBeenNthCalledWith(2, 7)
  })

  it('returns create failures as serializable results without rejecting IPC', async () => {
    const manager = makeManager()
    vi.mocked(manager.create).mockRejectedValueOnce(new Error('provider unavailable'))
    registerAgentHandlers({} as AuthManager, manager)
    const owner = makeSender(3)

    await expect(invoke(AGENT_CREATE, owner.sender, { panelId: 'one', cwd: '/work' })).resolves.toEqual({
      ok: false,
      error: 'provider unavailable',
    })
  })

  it('short-circuits empty session arguments and delegates non-empty paths unchanged', async () => {
    const manager = makeManager()
    registerAgentHandlers({} as AuthManager, manager)
    const owner = makeSender(1).sender
    h.listSessions.mockResolvedValue([{ id: 'session' }])
    h.loadSessionTranscript.mockResolvedValue([{ type: 'user', text: 'hello' }])

    await expect(invoke(AGENT_LIST_SESSIONS, owner, '')).resolves.toEqual([])
    await expect(invoke(AGENT_LOAD_SESSION_MESSAGES, owner, '')).resolves.toEqual([])
    await expect(invoke(AGENT_DELETE_SESSION, owner, '')).resolves.toBeUndefined()
    expect(h.listSessions).not.toHaveBeenCalled()
    expect(h.loadSessionTranscript).not.toHaveBeenCalled()
    expect(h.deleteSession).not.toHaveBeenCalled()

    await expect(invoke(AGENT_LIST_SESSIONS, owner, 'cate-runtime://server/work')).resolves.toEqual([{ id: 'session' }])
    await expect(invoke(AGENT_LOAD_SESSION_MESSAGES, owner, 'cate-runtime://server/session.jsonl')).resolves.toEqual([
      { type: 'user', text: 'hello' },
    ])
    await invoke(AGENT_DELETE_SESSION, owner, 'cate-runtime://server/session.jsonl')

    expect(h.listSessions).toHaveBeenCalledWith('cate-runtime://server/work')
    expect(h.loadSessionTranscript).toHaveBeenCalledWith('cate-runtime://server/session.jsonl')
    expect(h.deleteSession).toHaveBeenCalledWith('cate-runtime://server/session.jsonl')
  })

  it('routes prompts and records only anonymous message metadata', async () => {
    const manager = makeManager()
    registerAgentHandlers({} as AuthManager, manager)
    const owner = makeSender(1).sender
    const images = [{ mimeType: 'image/png', data: 'secret-image-data' }]

    await invoke(AGENT_PROMPT, owner, 'panel-1', 'do not log this prompt', images)

    expect(manager.prompt).toHaveBeenCalledWith('panel-1', 'do not log this prompt', images)
    expect(h.sendEvent).toHaveBeenCalledWith('agent_message_sent', {
      kind: 'prompt', chars: 22, has_images: true,
    })
    expect(JSON.stringify(h.sendEvent.mock.calls)).not.toContain('do not log this prompt')
    expect(JSON.stringify(h.sendEvent.mock.calls)).not.toContain('secret-image-data')
  })

  it('lists, saves, and deletes custom providers through IPC', async () => {
    const manager = makeManager()
    manager.syncCustomModelsToOpenSessions = vi.fn(async () => {})
    registerAgentHandlers({} as AuthManager, manager)
    const owner = makeSender(1).sender
    const provider = {
      id: 'custom-openai-team',
      name: 'Team Proxy',
      baseUrl: 'https://team.example/v1',
      apiKey: 'secret',
      models: ['team-model'],
    }
    h.readCustomOpenAIProviders.mockResolvedValue([provider])

    await expect(invoke(AGENT_CUSTOM_MODELS_GET, owner)).resolves.toEqual([provider])
    await invoke(AGENT_CUSTOM_MODELS_SAVE, owner, provider)
    await invoke(AGENT_CUSTOM_MODELS_DELETE, owner, provider.id)

    expect(h.saveCustomOpenAIProvider).toHaveBeenCalledWith(provider)
    expect(h.deleteCustomOpenAIProvider).toHaveBeenCalledWith(provider.id)
    expect(manager.syncCustomModelsToOpenSessions).toHaveBeenCalledTimes(2)
  })
})
