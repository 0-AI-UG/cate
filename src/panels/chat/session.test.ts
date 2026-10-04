import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRpcError } from '@kernel/rpc/contract'
import { createPanelRegistry, createSessionHost, type SessionHost } from '@panels/framework/runtime'
import type { T3PanelParams, T3ShellEvent, T3ShellSnapshot, T3Thread } from '@services/t3/contract'
import { MAIN_WINDOW, type PanelRecord } from '@workspace/document/contract'
import { createDocumentService, type DocumentService } from '@workspace/document/runtime'
import type { ChatSnapshot } from './contract'
import { chatPanel, createChatBindings, type ChatBindings, type ChatSessionDeps } from './runtime'

const ROOT = '/repo'

function fakeT3() {
  const listeners = new Set<(event: T3ShellEvent) => void>()
  let port = 5000
  const t3 = {
    panelUrl: vi.fn(async (params: T3PanelParams) => ({
      url: `http://127.0.0.1:${port}/${params.threadId ? `env/${params.threadId}` : ''}`,
      port,
      instanceId: `inst:${params.checkout}`,
      environmentId: 'env',
      threadId: params.threadId ?? null,
      session: { name: 't3_session', value: `cookie-${port}` },
    })),
    restart: vi.fn(async () => { port++ }),
    renameConversation: vi.fn(async () => {}),
    watchThreadShells: vi.fn((listener: (event: T3ShellEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
    emit(event: T3ShellEvent) { for (const listener of [...listeners]) listener(event) },
    setPort(next: number) { port = next },
    listeners,
  }
  return t3
}

const shell = (threads: Record<string, T3Thread>, connected = true, sequence = 1): T3ShellSnapshot =>
  ({ instanceId: `inst:${ROOT}`, checkout: ROOT, connected, sequence, threads })

let dir: string
let document: DocumentService
let host: SessionHost
let t3: ReturnType<typeof fakeT3>
let bindings: ChatBindings
let deps: ChatSessionDeps
let surfaces: { request: ReturnType<typeof vi.fn<(panelId: string, op: string, args: unknown) => Promise<unknown>>> }

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-chat-'))
  document = createDocumentService({ file: path.join(dir, 'document.json'), debounceMs: 60_000 })
  t3 = fakeT3()
  bindings = createChatBindings()
  surfaces = { request: vi.fn(async (_panelId: string, _op: string, _args: unknown) => true as unknown) }
  deps = {
    root: ROOT,
    t3,
    bindings,
    send: vi.fn(async () => ({ ok: true as const })),
    relationContext: vi.fn(async () => 'context'),
    createPanel: vi.fn(() => 'created'),
  }
  host = createSessionHost({
    document,
    registry: createPanelRegistry([chatPanel(deps)]),
    surfaces,
    sessionFile: (panelId) => path.join(dir, 'sessions', `${panelId}.json`),
  })
})

afterEach(async () => {
  host.dispose()
  document.dispose()
  await fs.rm(dir, { recursive: true, force: true })
})

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function addChat(fields: PanelRecord['fields'] = {}, extra: Partial<PanelRecord> = {}): Promise<void> {
  document.apply({
    kind: 'addPanel',
    record: { id: 'chat', type: 'chat', title: 'T3 Code', fields, ...extra },
    at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' },
  })
  await host.started('chat')
  await settle()
}

const snapshot = () => host.session('chat')!.snapshot() as ChatSnapshot
const op = (value: unknown) => host.op('chat', value, { clientId: 'c', connectionId: 1 })

describe('ChatSession binding', () => {
  it('loads the checkout harness on start and registers its binding', async () => {
    await addChat()
    expect(t3.watchThreadShells).toHaveBeenCalledOnce()
    expect(t3.panelUrl).toHaveBeenCalledWith({ checkout: ROOT, route: 'thread' })
    expect(snapshot()).toMatchObject({
      checkout: ROOT, threadId: null, phase: 'ready', loadId: 1,
      harness: { origin: 'http://127.0.0.1:5000', port: 5000, environmentId: 'env', session: { value: 'cookie-5000' } },
    })
    expect(bindings.binding('chat')).toEqual({ checkout: ROOT })
  })

  it('reloads for a selected conversation and adopts one the page created without reloading', async () => {
    await addChat()
    expect(await op({ kind: 'selectThread', threadId: 'one', title: 'Fix login', checkout: ROOT })).toBe(true)
    await settle()
    expect(document.get().panels.chat).toMatchObject({ title: 'Fix login', fields: { threadId: 'one' } })
    expect(t3.panelUrl).toHaveBeenLastCalledWith({ checkout: ROOT, threadId: 'one', route: 'thread' })
    expect(snapshot()).toMatchObject({ threadId: 'one', loadId: 2 })
    expect(bindings.binding('chat')).toEqual({ checkout: ROOT, threadId: 'one' })

    await op({ kind: 'adoptThread', threadId: 'two' })
    await settle()
    expect(document.get().panels.chat.fields.threadId).toBe('two')
    expect(t3.panelUrl).toHaveBeenCalledTimes(2)
    expect(snapshot()).toMatchObject({ threadId: 'two', loadId: 2 })
    expect(bindings.binding('chat')).toEqual({ checkout: ROOT, threadId: 'two' })
  })

  it('ignores a selection made for another checkout', async () => {
    await addChat()
    expect(await op({ kind: 'selectThread', threadId: 'one', checkout: '/elsewhere' })).toBe(false)
    expect(document.get().panels.chat.fields.threadId).toBeUndefined()
  })

  it('drops its thread and explicit cwd when switched to another worktree', async () => {
    document.apply({ kind: 'setWorktree', worktree: { id: 'wt', path: '/repo-wt', color: 'green', status: 'ready' } })
    await addChat({ threadId: 'one', cwd: ROOT })
    document.apply({ kind: 'updatePanel', id: 'chat', patch: { worktreeId: 'wt' } })
    await settle()
    expect(document.get().panels.chat.fields).toEqual({})
    expect(t3.panelUrl).toHaveBeenLastCalledWith({ checkout: '/repo-wt', route: 'thread' })
    expect(snapshot()).toMatchObject({ checkout: '/repo-wt', threadId: null })
  })

  it('switches worktree through its op, back to the root with null', async () => {
    document.apply({ kind: 'setWorktree', worktree: { id: 'wt', path: '/repo-wt', color: 'green', status: 'ready' } })
    await addChat({ threadId: 'one' })
    await op({ kind: 'switchWorktree', worktreeId: 'wt' })
    await settle()
    expect(document.get().panels.chat).toMatchObject({ worktreeId: 'wt', fields: {} })
    expect(snapshot()).toMatchObject({ checkout: '/repo-wt', threadId: null })
    await op({ kind: 'switchWorktree', worktreeId: null })
    await settle()
    expect(snapshot().checkout).toBe(ROOT)
    await expect(op({ kind: 'switchWorktree', worktreeId: 'nope' })).rejects.toSatisfy((e) => isRpcError(e, 'gone'))
  })
})

describe('ChatSession and the harness', () => {
  it('closes its panel when its conversation is deleted', async () => {
    await addChat({ threadId: 'one' })
    t3.emit({ kind: 'deleted', instanceId: `inst:${ROOT}`, threadId: 'other' })
    expect(document.get().panels.chat).toBeDefined()
    t3.emit({ kind: 'deleted', instanceId: `inst:${ROOT}`, threadId: 'one' })
    expect(document.get().panels.chat).toBeUndefined()
    expect(bindings.binding('chat')).toBeUndefined()
    expect(t3.listeners.size).toBe(0)
  })

  it('reloads the view when the harness comes back on another port', async () => {
    await addChat()
    t3.emit({ kind: 'snapshot', snapshot: shell({}, true) })
    expect(snapshot().connected).toBe(true)
    t3.emit({ kind: 'snapshot', snapshot: shell({}, false) })
    expect(snapshot().connected).toBe(false)
    t3.setPort(6000)
    t3.emit({ kind: 'snapshot', snapshot: shell({}, true, 1) })
    await settle()
    expect(snapshot()).toMatchObject({ loadId: 2, harness: { port: 6000, session: { value: 'cookie-6000' } } })
  })

  it('keeps the page when only the shell stream reconnected', async () => {
    await addChat()
    t3.emit({ kind: 'snapshot', snapshot: shell({}, true) })
    t3.emit({ kind: 'snapshot', snapshot: shell({}, false) })
    t3.emit({ kind: 'snapshot', snapshot: shell({}, true) })
    await settle()
    expect(snapshot().loadId).toBe(1)
  })

  it('publishes the bound thread activity and agent', async () => {
    await addChat({ threadId: 'one' })
    const running: T3Thread = { id: 'one', title: 'One', latestTurn: { state: 'running' }, session: { status: 'running', activeTurnId: 't', providerName: 'codex' } }
    t3.emit({ kind: 'snapshot', snapshot: shell({ one: running }) })
    expect(snapshot()).toMatchObject({ connected: true, activity: 'running', agentName: 'Codex', canReceivePrompt: false })
    t3.emit({ kind: 'snapshot', snapshot: shell({ one: { ...running, latestTurn: { state: 'completed' }, session: { status: 'ready', activeTurnId: null, providerName: 'codex' } } }, true, 2) })
    expect(snapshot()).toMatchObject({ activity: 'waitingForInput', canReceivePrompt: true })
  })

  it('restarts the harness on retry and reports failures', async () => {
    await addChat()
    await op({ kind: 'retry' })
    expect(t3.restart).toHaveBeenCalledWith({ checkout: ROOT })
    expect(snapshot()).toMatchObject({ phase: 'ready', loadId: 2, harness: { port: 5001 } })
    t3.panelUrl.mockRejectedValueOnce(new Error('T3 exited'))
    await op({ kind: 'retry' })
    expect(snapshot()).toMatchObject({ phase: 'error', error: 'T3 exited' })
  })

  it('reports a page load failure only for the current load', async () => {
    await addChat()
    await op({ kind: 'loadFailed', loadId: 0, message: 'stale' })
    expect(snapshot().phase).toBe('ready')
    await op({ kind: 'loadFailed', loadId: 1, message: 'ERR_CONNECTION_REFUSED' })
    expect(snapshot()).toMatchObject({ phase: 'error', error: 'ERR_CONNECTION_REFUSED' })
  })
})

describe('ChatSession ops', () => {
  const at = { to: 'stack' as const, dock: { windowId: MAIN_WINDOW }, stackId: 's2' }

  it('opens files of its checkout and refuses paths outside it or a stale thread', async () => {
    await addChat({ threadId: 'one' })
    expect(await op({ kind: 'openFile', path: 'src/index.ts', at, threadId: 'one' })).toBe(true)
    expect(deps.createPanel).toHaveBeenCalledWith('editor', { near: 'chat', at, filePath: '/repo/src/index.ts' })
    for (const bad of ['../secret', '/etc/passwd', 'C:\\x']) {
      await expect(op({ kind: 'openFile', path: bad, at })).rejects.toSatisfy((e: unknown) => isRpcError(e, 'rejected'))
    }
    await expect(op({ kind: 'openFile', path: 'a.ts', at, threadId: 'other' })).rejects.toThrow('Conversation changed')
  })

  it('opens the thread changes in a review and a conversation in a new chat', async () => {
    await addChat({ threadId: 'one' })
    await op({ kind: 'openChanges', at, filePath: 'a.ts', turnId: 't1', threadId: 'one' })
    expect(deps.createPanel).toHaveBeenCalledWith('review', expect.objectContaining({
      at,
      repoPath: ROOT,
      request: { spec: { kind: 'uncommitted' }, focusedFile: 'a.ts', agentChanges: { panelId: 'chat', sessionId: 'one', turnId: 't1' } },
    }))
    await op({ kind: 'openChat', at, threadId: 'two', title: 'Two' })
    expect(deps.createPanel).toHaveBeenLastCalledWith('chat', { near: 'chat', at, threadId: 'two', title: 'Two' })
  })

  it('starts turns through the agents service and a fresh chat through the page', async () => {
    await addChat()
    expect(await op({ kind: 'startTurn', text: 'hi' })).toEqual({ ok: true })
    expect(deps.send).toHaveBeenCalledWith('chat', 'hi')
    expect(await bindings.sendFresh('chat', 'first prompt')).toBe(true)
    expect(surfaces.request).toHaveBeenCalledWith('chat', 'chat.sendText', { text: 'first prompt' }, undefined)
    expect(await op({ kind: 'relationContext', provider: 'claudeAgent' })).toBe('context')
    expect(deps.relationContext).toHaveBeenCalledWith('chat', 'claude-code')
  })

  it('renames its bound conversation', async () => {
    await addChat({ threadId: 'one' })
    await op({ kind: 'renameConversation', title: 'Renamed' })
    expect(t3.renameConversation).toHaveBeenCalledWith({ checkout: ROOT, threadId: 'one', title: 'Renamed' })
  })
})
