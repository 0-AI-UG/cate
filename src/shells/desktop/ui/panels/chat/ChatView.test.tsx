// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientIdentity, installClientIdentity, type SessionHandle } from '@client/connections'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { installMockClientUi } from '../../../../../test/clientUi'
import { HOST_MESSAGE_PREFIX } from '@services/t3/client'
import { installT3WebviewHost } from '@services/t3/desktop'
import { MAIN_WINDOW, type PanelRecord } from '@workspace/document/contract'
import { chatPageUrl, type ChatOp, type ChatSnapshot } from '@panels/chat/contract'
import { runSurfaceRequest } from '@client/host'
import ChatView from './ChatView'

const pickPanelPlace = vi.hoisted(() => vi.fn())
const openUrlInPanel = vi.hoisted(() => vi.fn((_workspaceId: string, _url: string, _near?: string) => true))
vi.mock('@client/host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@client/host')>()
  const { isLoopbackUrl } = await import('@runtime/tunnel/contract')
  const { clientUi } = await import('@kernel/interaction')
  // The real routing, with the panel creation observed.
  const openUrlFor = (workspaceId: string, url: string, near?: string) => {
    if (isLoopbackUrl(url)) openUrlInPanel(workspaceId, url, near)
    else clientUi().openExternal(url)
  }
  return { ...actual, pickPanelPlace, openUrlFor }
})

vi.mock('../../workspace/repository', () => ({ WorktreePill: () => null }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const harness = { origin: 'http://127.0.0.1:49152', port: 49152, instanceId: 'inst', environmentId: 'env', session: { name: 't3_session', value: 'secret' } }
const ready = (patch: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  checkout: '/repo', threadId: null, phase: 'ready', error: null, harness, loadId: 1,
  connected: true, changes: null, ...patch,
})
const record: PanelRecord = { id: 'chat', type: 'chat', title: 'T3 Code', fields: {} }
const at = { to: 'stack' as const, dock: { windowId: MAIN_WINDOW }, stackId: 's2' }

const session: SessionHandle<ChatSnapshot> = {
  panelId: 'chat',
  getSnapshot: () => null,
  subscribe: () => () => {},
  send: async () => undefined,
  release: () => {},
}
const runtime = { t3: { conversations: vi.fn(async () => []), renameConversation: vi.fn(), deleteConversation: vi.fn() } } as unknown as RuntimeProxy

let host: HTMLDivElement
let root: Root
let send: ReturnType<typeof vi.fn<(op: ChatOp) => Promise<unknown>>>
let ui: ReturnType<typeof installMockClientUi>
let setCookie: ReturnType<typeof vi.fn<(partition: string, url: string, cookie: { name: string; value: string }) => Promise<void>>>
let stops: Array<() => void> = []

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  send = vi.fn(async () => true)
  setCookie = vi.fn(async () => {})
  ui = installMockClientUi({ showContextMenu: vi.fn(async () => null) })
  pickPanelPlace.mockReset().mockResolvedValue({ kind: 'new', at })
  openUrlInPanel.mockClear()
  stops = [
    installT3WebviewHost({ partition: (id) => `persist:ws-${id}`, setCookie }),
    setRuntimeResolver(() => runtime),
  ]
})

afterEach(async () => {
  await act(async () => root.unmount())
  for (const stop of stops) stop()
  host.remove()
})

async function render(snapshot: ChatSnapshot | null, props: { focused?: boolean } = {}) {
  await act(async () => root.render(
    <ChatView workspaceId="ws" panelId="chat" record={record} session={session} send={send as never}
      snapshot={snapshot} visible focused={props.focused ?? false} />,
  ))
}

function mockGuest(url = `${harness.origin}/`) {
  return Object.assign(host.querySelector<HTMLElement>('webview')!, {
    getURL: vi.fn(() => url),
    insertCSS: vi.fn().mockResolvedValue('css'),
    executeJavaScript: vi.fn().mockResolvedValue(undefined),
    loadURL: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn(),
  })
}

/** The in-place navigations the view ran in the page. */
const navigations = (guest: ReturnType<typeof mockGuest>) => guest.executeJavaScript.mock.calls
  .map(([script]) => String(script))
  .filter((script) => script.includes('__cateRouter'))
  .map((script) => /href: "([^"]+)"/.exec(script)![1])

const fire = (guest: HTMLElement, type: string, fields: object = {}) =>
  act(async () => { guest.dispatchEvent(Object.assign(new Event(type), fields)) })

async function readyGuest(url?: string) {
  const guest = mockGuest(url)
  await fire(guest, 'dom-ready')
  const setup = String(guest.executeJavaScript.mock.calls[0][0])
  const token = /token: "([^"]+)"/.exec(setup)![1]
  return { guest, token }
}

describe('ChatView states', () => {
  it('shows loading feedback while the harness is starting', async () => {
    await render(null)
    expect(host.textContent).toContain('Starting T3 Code')
    await render(ready({ phase: 'loading', harness: null }))
    expect(host.textContent).toContain('Starting T3 Code')
    expect(host.querySelector('webview')).toBeNull()
  })

  it('shows an error with a retry when the harness fails', async () => {
    await render(ready({ phase: 'error', error: 'T3Code exited' }))
    expect(host.textContent).toContain('T3 Code unavailable')
    expect(host.textContent).toContain('T3 Code exited')
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click())
    expect(send).toHaveBeenCalledWith({ kind: 'retry' })
  })
})

describe('ChatView page', () => {
  it('installs the session cookie and loads the bound thread in the workspace partition', async () => {
    await render(ready({ threadId: 'one' }))
    expect(setCookie).toHaveBeenCalledWith('persist:ws-ws', harness.origin, harness.session)
    const webview = host.querySelector('webview')!
    expect(webview.getAttribute('src')).toBe(`${harness.origin}/env/one`)
    expect(webview.getAttribute('partition')).toBe('persist:ws-ws')
    expect(webview.getAttribute('data-chat-guest-ready')).toBe('false')
  })

  it('reveals the page only after branding and setup', async () => {
    await render(ready())
    const guest = mockGuest()
    let finishCss!: (value: string) => void
    guest.insertCSS.mockImplementation(() => new Promise((resolve) => { finishCss = resolve }))
    await fire(guest, 'dom-ready')
    expect(guest.getAttribute('data-chat-guest-ready')).toBe('false')
    expect(String(guest.executeJavaScript.mock.calls[0][0])).toContain('__cateHost')
    await act(async () => finishCss('css'))
    expect(guest.getAttribute('data-chat-guest-ready')).toBe('true')
  })

  it('adopts a thread the page created without reloading it', async () => {
    await render(ready())
    const { guest } = await readyGuest()
    await fire(guest, 'did-navigate-in-page', { url: `${harness.origin}/env/created` })
    expect(send).toHaveBeenCalledWith({ kind: 'adoptThread', threadId: 'created' })
    // Until the session confirms, the new thread counts as bound.
    await fire(guest, 'did-navigate-in-page', { url: `${harness.origin}/env/created` })
    expect(navigations(guest)).toEqual([])
    expect(guest.loadURL).not.toHaveBeenCalled()
    await render(ready({ threadId: 'created' }))
    expect(host.querySelector('webview')).toBe(guest)
  })

  it('keeps the page on its thread, ignores subframes and hands provider settings to Cate', async () => {
    await render(ready({ threadId: 'one' }))
    const { guest } = await readyGuest(`${harness.origin}/env/one`)
    await fire(guest, 'did-navigate-in-page', { url: 'https://embedded.example/#x', isMainFrame: false })
    expect(navigations(guest)).toEqual([])
    await fire(guest, 'did-navigate', { url: `${harness.origin}/env/other` })
    expect(navigations(guest)).toEqual(['/env/one'])
    await fire(guest, 'did-navigate', { url: `${harness.origin}/settings/providers` })
    expect(ui.openSettings).toHaveBeenCalledWith('t3 code')
    const prevent = vi.fn()
    await fire(guest, 'will-navigate', { url: `${harness.origin}/pull-requests`, preventDefault: prevent })
    expect(prevent).toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'adoptThread' }))
  })

  it('follows a thread another client moved the panel to in place', async () => {
    await render(ready())
    const { guest } = await readyGuest()
    await render(ready({ threadId: 'theirs' }))
    expect(navigations(guest)).toEqual(['/env/theirs'])
    expect(guest.loadURL).not.toHaveBeenCalled()
    expect(host.querySelector('webview')).toBe(guest)
  })

  it('reports main document load failures only', async () => {
    await render(ready())
    const guest = mockGuest()
    await fire(guest, 'did-fail-load', { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', isMainFrame: false })
    await fire(guest, 'did-fail-load', { errorCode: -3, errorDescription: 'ERR_ABORTED', isMainFrame: true })
    expect(send).not.toHaveBeenCalled()
    await fire(guest, 'did-fail-load', { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', isMainFrame: true })
    expect(send).toHaveBeenCalledWith({ kind: 'loadFailed', loadId: 1, message: 'ERR_NAME_NOT_RESOLVED' })
  })

  it('reloads for a new load and cancels the old page requests', async () => {
    await render(ready())
    const { guest } = await readyGuest()
    await render(ready({ threadId: 'next', loadId: 2 }))
    expect(guest.executeJavaScript).toHaveBeenCalledWith('window.__cateHost?.cancelPending()')
    const next = host.querySelector('webview')!
    expect(next).not.toBe(guest)
    expect(next.getAttribute('src')).toBe(`${harness.origin}/env/next`)
  })

  it('pushes change summaries for the bound thread', async () => {
    const changes = { threadId: 'one', turns: { t1: [{ path: 'a.ts', kind: 'modified' as const, additions: 1, deletions: 0 }] } }
    await render(ready({ threadId: 'one', changes }))
    const { guest } = await readyGuest(chatPageUrl(harness, 'one'))
    const pushed = guest.executeJavaScript.mock.calls.map(([script]) => String(script)).filter((script) => script.includes('__cateChanges'))
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toContain('"a.ts"')
  })

  it('runs the send-text page operation on the ready page', async () => {
    await render(ready())
    const { guest } = await readyGuest()
    guest.executeJavaScript.mockResolvedValue(true)
    expect(await runSurfaceRequest('ws', { requestId: 1, panelId: 'chat', op: 'chat.sendText', args: { text: 'hi' } })).toBe(true)
    expect(String(guest.executeJavaScript.mock.lastCall![0])).toContain('sendText?.("hi")')
  })
})

describe('ChatView bridge', () => {
  const request = (token: string, id: string, action: string, payload: object) =>
    HOST_MESSAGE_PREFIX + JSON.stringify({ token, id, action, payload })

  it('opens external links through the client UI and replies to the page', async () => {
    await render(ready())
    const { guest, token } = await readyGuest()
    await fire(guest, 'console-message', { message: request(token, 'r1', 'external', { url: 'https://example.com/pr/1' }) })
    expect(ui.openExternal).toHaveBeenCalledWith('https://example.com/pr/1')
    expect(guest.executeJavaScript).toHaveBeenLastCalledWith('window.__cateHost?.reply("r1", true, null)')
  })

  it('opens loopback links in a browser panel next to the chat, never in the system browser', async () => {
    await render(ready())
    const { guest, token } = await readyGuest()
    await fire(guest, 'console-message', { message: request(token, 'r1', 'external', { url: 'http://localhost:3000/' }) })
    expect(openUrlInPanel).toHaveBeenCalledWith('ws', 'http://localhost:3000/', 'chat')
    expect(ui.openExternal).not.toHaveBeenCalled()
  })

  it('ignores requests without the binding token', async () => {
    await render(ready())
    const { guest } = await readyGuest()
    await fire(guest, 'console-message', { message: request('forged', 'r1', 'external', { url: 'https://example.com/' }) })
    expect(ui.openExternal).not.toHaveBeenCalled()
  })

  it('asks where a file goes, then sends the session op', async () => {
    await render(ready({ threadId: 'one' }))
    const { guest, token } = await readyGuest()
    await fire(guest, 'console-message', { message: request(token, 'r2', 'file', { threadId: 'one', filePath: 'src/a.ts' }) })
    expect(pickPanelPlace).toHaveBeenCalledWith({ workspaceId: 'ws', sourcePanelId: 'chat', panelType: 'editor', availability: 'new' })
    expect(send).toHaveBeenCalledWith({ kind: 'openFile', path: 'src/a.ts', at, threadId: 'one' })
  })

  it('places a handed-off conversation in a new chat panel', async () => {
    await render(ready({ threadId: 'one' }))
    const { guest, token } = await readyGuest()
    await fire(guest, 'console-message', { message: request(token, 'r3', 'place-agent', {}) })
    const placement = /reply\("r3", "([^"]+)"/.exec(String(guest.executeJavaScript.mock.lastCall![0]))![1]
    await fire(guest, 'console-message', { message: request(token, 'r4', 'open-agent', { placementId: placement, threadId: 'two', title: 'Two' }) })
    expect(pickPanelPlace).toHaveBeenCalledWith({ workspaceId: 'ws', sourcePanelId: 'chat', panelType: 'chat', availability: 'new' })
    expect(send).toHaveBeenCalledWith({ kind: 'openChat', at, threadId: 'two', title: 'Two' })
  })

  it('shows a failed action and lets the user dismiss it', async () => {
    await render(ready({ threadId: 'one' }))
    const { guest, token } = await readyGuest()
    await fire(guest, 'console-message', { message: request(token, 'r5', 'file', { threadId: 'one', filePath: '../secret' }) })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('File is outside this project.')
    expect(guest.executeJavaScript).toHaveBeenLastCalledWith('window.__cateHost?.reply("r5", null, "File is outside this project.")')
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!.click())
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('ChatView file drops', () => {
  const dropOsImage = async () => {
    const overlay = host.querySelector<HTMLElement>('[data-filedrop="chat"]')!
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
    const dataTransfer = { types: ['Files'], files: [file], getData: () => '' }
    await act(async () => { overlay.dispatchEvent(Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer })) })
  }
  const dropScripts = (guest: ReturnType<typeof mockGuest>) =>
    guest.executeJavaScript.mock.calls.map(([script]) => String(script)).filter((script) => script.includes('new DataTransfer()'))

  afterEach(() => installClientIdentity(null))

  it('takes OS image files on a client with fileDrop', async () => {
    installClientIdentity(createClientIdentity({ device: { name: 'd', keyFingerprint: 'FP' }, features: ['fileDrop'] }))
    await render(ready())
    const { guest } = await readyGuest()
    await dropOsImage()
    await vi.waitFor(() => expect(dropScripts(guest)).toHaveLength(1))
  })
})
