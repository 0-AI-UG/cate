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
import { createEnginePasskeys } from './passkeys'

let frame: any
let contents: any
const input = { id: '11111111-1111-4111-8111-111111111111', operation: 'get', options: { challenge: 'AQ' } }
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('process', { ...process, platform: 'darwin', getSystemVersion: () => '15.0' })
  frame = { url: 'https://example.com/login', isDestroyed: () => false }
  contents = Object.assign(new EventEmitter(), { id: 5, mainFrame: frame, getType: () => 'webview', isFocused: () => true, isDestroyed: () => false })
  mocks.owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: () => true, getNativeWindowHandle: () => Buffer.alloc(8) })
  mocks.request.mockResolvedValue(JSON.stringify({ error: 'NotAllowedError' }))
  mocks.available.mockReturnValue(true)
  mocks.registered.mockReturnValue(true)
})
afterEach(() => vi.unstubAllGlobals())

// The isolated engine retains frame/origin checks in its own process; the
// native side must still require a live, focused shell window.
it('relays validated engine requests to the actual shell window only', async () => {
  mocks.owner.isFocused = () => true
  const passkeys = createEnginePasskeys({ owner: () => mocks.owner })
  await passkeys.request(9, 'https://example.com', input)
  expect(JSON.parse(mocks.request.mock.calls[0][0])).toMatchObject({ origin: 'https://example.com', options: { rpId: 'example.com' } })
  mocks.request.mockClear()
  mocks.owner.isFocused = () => false
  expect(await passkeys.request(9, 'https://example.com', input)).toEqual({ error: 'NotAllowedError' })
  expect(mocks.request).not.toHaveBeenCalled()
})
it('cancels outstanding native operations when the browser engine exits', async () => {
  mocks.owner.isFocused = () => true
  let finish!: (value: string) => void
  mocks.request.mockImplementation(() => new Promise<string>(resolve => { finish = resolve }))
  const passkeys = createEnginePasskeys({ owner: () => mocks.owner })
  const request = passkeys.request(9, 'https://example.com', input)
  passkeys.cancel(10, input.id)
  expect(mocks.cancel).not.toHaveBeenCalled()
  passkeys.cancelAll()
  expect(mocks.cancel).toHaveBeenCalledWith(input.id)
  finish('{}')
  expect(await request).toEqual({ error: 'AbortError' })
  expect(mocks.owner.listenerCount('closed')).toBe(0)
})

it('rejects a relying party outside the engine-pinned origin', async () => {
  mocks.owner.isFocused = () => true
  const passkeys = createEnginePasskeys({ owner: () => mocks.owner })
  expect(await passkeys.request(9, 'https://example.com', { ...input, options: { challenge: 'AQ', rpId: 'evil.com' } })).toEqual({ error: 'SecurityError' })
  expect(mocks.request).not.toHaveBeenCalled()
})
