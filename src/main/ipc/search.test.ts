import { beforeEach, expect, it, vi } from 'vitest'
import { SEARCH_START, SEARCH_CANCEL, SEARCH_DONE } from '../../shared/ipc-channels'
const h = vi.hoisted(() => ({ handlers: new Map<string, Function>(), disconnected: undefined as undefined | ((id: string) => void), owner: 1, handles: [] as { cancel: ReturnType<typeof vi.fn> }[] }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: Function) => h.handlers.set(name, fn) } }))
vi.mock('../windowRegistry', () => ({ windowFromEvent: () => ({ id: h.owner }) }))
vi.mock('../runtime/runtimeManager', () => ({ runtimes: { onDisconnected: (cb: (id: string) => void) => { h.disconnected = cb; return () => {} }, resolve: () => ({ file: { searchContent: () => {
  const handle = { cancel: vi.fn() }; h.handles.push(handle); return handle
} } }) } }))
import { registerHandlers, stopSearchesForWindow } from './search'
const event = { sender: { id: 1, isDestroyed: () => false, send: vi.fn() } }
beforeEach(() => { stopSearchesForWindow(1); h.handles = []; registerHandlers() })
it('does not cancel another panel when starting or cancelling a search', async () => {
  await h.handlers.get(SEARCH_START)!(event, '/a', 'search-a', { query: 'one' }, 'w')
  await h.handlers.get(SEARCH_START)!(event, '/b', 'search-b', { query: 'two' }, 'w')
  expect(h.handles[0].cancel).not.toHaveBeenCalled()
  await h.handlers.get(SEARCH_CANCEL)!(event, 'search-b')
  expect(h.handles[0].cancel).not.toHaveBeenCalled()
  expect(h.handles[1].cancel).toHaveBeenCalledOnce()
  stopSearchesForWindow(1)
  expect(h.handles[0].cancel).toHaveBeenCalledOnce()
})

it('tears down by BrowserWindow identity rather than sender WebContents identity', async () => {
  h.owner = 7
  const sender = { id: 42, isDestroyed: () => false, send: vi.fn() }
  await h.handlers.get(SEARCH_START)!({ sender }, '/a', 'owned-search', { query: 'one' }, 'w')
  stopSearchesForWindow(7)
  expect(h.handles.at(-1)!.cancel).toHaveBeenCalledOnce()
  h.owner = 1
})
it('completes an established search once when its runtime disconnects', async () => {
  event.sender.send.mockClear()
  await h.handlers.get(SEARCH_START)!(event, '/a', 'interrupted', { query: 'one' }, 'w')
  h.disconnected?.('local')
  h.disconnected?.('local')
  const done = event.sender.send.mock.calls.filter(call => call[0] === SEARCH_DONE)
  expect(done).toHaveLength(1)
  expect(done[0][1]).toMatchObject({ searchId: 'interrupted', error: expect.stringMatching(/disconnect|interrupt/i) })
  expect(h.handles.at(-1)!.cancel).toHaveBeenCalledOnce()
})
