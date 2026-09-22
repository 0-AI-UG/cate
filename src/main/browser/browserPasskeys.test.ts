import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  on: vi.fn(), handle: vi.fn(), registered: vi.fn(() => true),
  available: vi.fn(() => true), request: vi.fn(), cancel: vi.fn(), owner: undefined as any,
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/test' },
  BrowserWindow: { fromWebContents: () => mocks.owner },
  ipcMain: { on: mocks.on, handle: mocks.handle },
}))
vi.mock('node:module', () => ({ createRequire: () => () => ({ isAvailable: mocks.available, request: mocks.request, cancel: mocks.cancel }) }))
vi.mock('./browserRuntime', () => ({ browserRuntime: { isRegistered: mocks.registered } }))
vi.mock('../logger', () => ({ default: { info: vi.fn() } }))
import { registerBrowserPasskeys } from './browserPasskeys'

let frame: any
let contents: any
const input = { id: '11111111-1111-4111-8111-111111111111', operation: 'get', options: { challenge: 'AQ' } }
const invoke = (event = { sender: contents, senderFrame: frame }, value = input) => mocks.handle.mock.calls[0][1](event, value)
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('process', { ...process, platform: 'darwin', getSystemVersion: () => '15.0' })
  frame = { url: 'https://example.com/login', isDestroyed: () => false }
  contents = Object.assign(new EventEmitter(), { id: 5, mainFrame: frame, getType: () => 'webview', isFocused: () => true, isDestroyed: () => false })
  mocks.owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: () => true, getNativeWindowHandle: () => Buffer.alloc(8) })
  mocks.request.mockResolvedValue(JSON.stringify({ error: 'NotAllowedError' }))
  mocks.available.mockReturnValue(true)
  mocks.registered.mockReturnValue(true)
  registerBrowserPasskeys()
})
afterEach(() => vi.unstubAllGlobals())

it('derives origin from the calling frame and validates RP before native dispatch', async () => {
  await invoke()
  expect(JSON.parse(mocks.request.mock.calls[0][0])).toMatchObject({ origin: 'https://example.com', options: { rpId: 'example.com' } })
  mocks.request.mockClear()
  expect(await invoke(undefined, { ...input, options: { challenge: 'AQ', rpId: 'evil.com' } } as any)).toEqual({ error: 'SecurityError' })
  expect(mocks.request).not.toHaveBeenCalled()
})
it('rejects unregistered guests and subframes', async () => {
  expect(await invoke({ sender: contents, senderFrame: { ...frame } })).toEqual({ error: 'NotAllowedError' })
  mocks.registered.mockReturnValue(false)
  expect(await invoke()).toEqual({ error: 'NotAllowedError' })
  expect(mocks.request).not.toHaveBeenCalled()
})
it('cancels on navigation and suppresses stale authenticator results', async () => {
  let resolve!: (result: string) => void
  mocks.request.mockImplementation(() => new Promise<string>((done) => { resolve = done }))
  const pending = invoke()
  contents.emit('did-start-navigation', {}, 'https://other.example', false, true)
  expect(mocks.cancel).toHaveBeenCalledWith(input.id)
  resolve(JSON.stringify({ id: 'AQ' }))
  expect(await pending).toEqual({ error: 'AbortError' })
  expect(contents.listenerCount('did-start-navigation')).toBe(0)
})
it('only accepts cancellation for the calling guest’s pending request', async () => {
  let resolve!: (result: string) => void
  mocks.request.mockImplementation(() => new Promise<string>((done) => { resolve = done }))
  const pending = invoke()
  const cancel = mocks.on.mock.calls.find(([name]) => name === 'cate-passkeys-cancel')![1]
  cancel({ sender: contents, senderFrame: frame }, 'other-request')
  expect(mocks.cancel).not.toHaveBeenCalled()
  cancel({ sender: contents, senderFrame: frame }, input.id)
  expect(mocks.cancel).toHaveBeenCalledWith(input.id)
  resolve('{}')
  await pending
})
