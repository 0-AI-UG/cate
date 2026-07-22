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
  readCustomOpenAI: vi.fn(),
  saveCustomOpenAI: vi.fn(),
}))

import { registerCodingHandlers } from './ipcCoding'
import {
  CODING_CREATE,
  CODING_DELETE_SESSION,
  CODING_LIST_SESSIONS,
  CODING_LOAD_SESSION_MESSAGES,
  CODING_PROMPT,
} from '../../shared/ipc-channels'
import type { CodingManager } from './codingManager'
import type { AuthManager } from './authManager'

function makeManager(): CodingManager {
  return {
    create: vi.fn(async () => {}),
    disposeForWebContents: vi.fn(),
    prompt: vi.fn(async () => {}),
  } as unknown as CodingManager
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
})

describe('agent IPC ownership and session routing', () => {
  it('hooks each owner window once and disposes all of its sessions when destroyed', async () => {
    const manager = makeManager()
    registerCodingHandlers({} as AuthManager, manager)
    const owner = makeSender(42)

    await expect(invoke(CODING_CREATE, owner.sender, { panelId: 'one', cwd: '/work' })).resolves.toEqual({ ok: true })
    await expect(invoke(CODING_CREATE, owner.sender, { panelId: 'two', cwd: '/work' })).resolves.toEqual({ ok: true })

    expect(owner.sender.once).toHaveBeenCalledTimes(1)
    expect(owner.sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function))
    expect(manager.create).toHaveBeenCalledTimes(2)

    owner.destroy()
    expect(manager.disposeForWebContents).toHaveBeenCalledOnce()
    expect(manager.disposeForWebContents).toHaveBeenCalledWith(42)
  })

  it('releases destroyed sender ids so a replacement sender with the same id gets cleanup ownership', async () => {
    const manager = makeManager()
    registerCodingHandlers({} as AuthManager, manager)
    const first = makeSender(7)
    await invoke(CODING_CREATE, first.sender, { panelId: 'first', cwd: '/work' })
    first.destroy()

    const replacement = makeSender(7)
    await invoke(CODING_CREATE, replacement.sender, { panelId: 'replacement', cwd: '/work' })

    expect(replacement.sender.once).toHaveBeenCalledOnce()
    replacement.destroy()
    expect(manager.disposeForWebContents).toHaveBeenNthCalledWith(1, 7)
    expect(manager.disposeForWebContents).toHaveBeenNthCalledWith(2, 7)
  })

  it('returns create failures as serializable results without rejecting IPC', async () => {
    const manager = makeManager()
    vi.mocked(manager.create).mockRejectedValueOnce(new Error('provider unavailable'))
    registerCodingHandlers({} as AuthManager, manager)
    const owner = makeSender(3)

    await expect(invoke(CODING_CREATE, owner.sender, { panelId: 'one', cwd: '/work' })).resolves.toEqual({
      ok: false,
      error: 'provider unavailable',
    })
  })

  it('short-circuits empty session arguments and delegates non-empty paths unchanged', async () => {
    const manager = makeManager()
    registerCodingHandlers({} as AuthManager, manager)
    const owner = makeSender(1).sender
    h.listSessions.mockResolvedValue([{ id: 'session' }])
    h.loadSessionTranscript.mockResolvedValue([{ type: 'user', text: 'hello' }])

    await expect(invoke(CODING_LIST_SESSIONS, owner, '')).resolves.toEqual([])
    await expect(invoke(CODING_LOAD_SESSION_MESSAGES, owner, '')).resolves.toEqual([])
    await expect(invoke(CODING_DELETE_SESSION, owner, '')).resolves.toBeUndefined()
    expect(h.listSessions).not.toHaveBeenCalled()
    expect(h.loadSessionTranscript).not.toHaveBeenCalled()
    expect(h.deleteSession).not.toHaveBeenCalled()

    await expect(invoke(CODING_LIST_SESSIONS, owner, 'cate-runtime://server/work')).resolves.toEqual([{ id: 'session' }])
    await expect(invoke(CODING_LOAD_SESSION_MESSAGES, owner, 'cate-runtime://server/session.jsonl')).resolves.toEqual([
      { type: 'user', text: 'hello' },
    ])
    await invoke(CODING_DELETE_SESSION, owner, 'cate-runtime://server/session.jsonl')

    expect(h.listSessions).toHaveBeenCalledWith('cate-runtime://server/work')
    expect(h.loadSessionTranscript).toHaveBeenCalledWith('cate-runtime://server/session.jsonl')
    expect(h.deleteSession).toHaveBeenCalledWith('cate-runtime://server/session.jsonl')
  })

  it('routes prompts and records only anonymous message metadata', async () => {
    const manager = makeManager()
    registerCodingHandlers({} as AuthManager, manager)
    const owner = makeSender(1).sender
    const images = [{ mimeType: 'image/png', data: 'secret-image-data' }]

    await invoke(CODING_PROMPT, owner, 'panel-1', 'do not log this prompt', images)

    expect(manager.prompt).toHaveBeenCalledWith('panel-1', 'do not log this prompt', images)
    expect(h.sendEvent).toHaveBeenCalledWith('agent_message_sent', {
      kind: 'prompt', chars: 22, has_images: true,
    })
    expect(JSON.stringify(h.sendEvent.mock.calls)).not.toContain('do not log this prompt')
    expect(JSON.stringify(h.sendEvent.mock.calls)).not.toContain('secret-image-data')
  })
})
