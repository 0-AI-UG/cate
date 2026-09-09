import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ handlers: new Map<string, Function>(), send: vi.fn(), cache: vi.fn(), retain: vi.fn(), clear: vi.fn(), buffer: vi.fn(), target: vi.fn(), crossTransfer: vi.fn(), abort: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (id: string, fn: Function) => h.handlers.set(id, fn), on: (id: string, fn: Function) => h.handlers.set(id, fn) }, BrowserWindow: { fromWebContents: (sender: any) => sender.window }, screen: { getCursorScreenPoint: () => ({ x: 100, y: 100 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) } }))
vi.mock('../windows/dragGhost', () => ({ createDragGhostWindow: vi.fn(), moveDragGhostWindow: vi.fn(), destroyDragGhostWindow: vi.fn(), getDragGhostWindow: vi.fn() }))
vi.mock('../windows/fullscreen', () => ({ anyWindowFullscreen: () => false }))
vi.mock('../windows/reveal', () => ({ revealWindow: vi.fn() }))
vi.mock('./terminal', () => ({ abortTerminalTransfer: h.abort, beginTerminalBuffering: h.buffer, setTerminalTransferTarget: h.target, handleCrossWindowDropTerminalTransfer: h.crossTransfer }))
vi.mock('../windowRegistry', () => ({ sendToWindow: h.send, broadcastToAll: vi.fn(), broadcastToAllExcept: vi.fn(), windowFromEvent: (event: any) => event.window, listWindows: () => [], setDockWindowState: h.cache, retainDockWindowRecovery: h.retain, clearDockWindowRecovery: h.clear }))
import { registerDragHandlers } from './dragHandlers'
import { DRAG_DETACH, PANEL_TRANSFER_READY, PANEL_TRANSFER_COMMIT, PANEL_TRANSFER_FINISH, PANEL_RECEIVE, CROSS_WINDOW_DRAG_START, CROSS_WINDOW_DRAG_DROP, CROSS_WINDOW_DRAG_RESOLVE } from '../../shared/ipc-channels'
beforeEach(() => { h.handlers.clear(); vi.clearAllMocks() })
it('keeps the source handoff pending until the destination accepts hydration', async () => {
  const window = Object.assign(new EventEmitter(), { id: 2, webContents: new EventEmitter(), setBounds: vi.fn(), isDestroyed: () => false, close: vi.fn() })
  registerDragHandlers({ createWindow: () => window as any })
  let settled = false
  const transfer = h.handlers.get(DRAG_DETACH)!({ window: { id: 1 } }, { panel: { id: 'editor', type: 'editor', isDirty: true, unsavedContent: 'only copy' }, geometry: { origin: { x: 0, y: 0 }, size: { width: 500, height: 400 } } }, 'ws').then(() => { settled = true })
  await Promise.resolve(); await Promise.resolve()
  expect(settled).toBe(false)
  window.emit('closed')
  await transfer
})

function receiver(id: number) {
  let destroyed = false
  const win = Object.assign(new EventEmitter(), {
    id, webContents: new EventEmitter(), setBounds: vi.fn(), isDestroyed: () => destroyed,
    close: vi.fn(() => { destroyed = true; win.emit('closed') }),
  })
  return win
}
async function commitTo(win: ReturnType<typeof receiver>, createWindow = vi.fn(() => win)) {
  registerDragHandlers({ createWindow: createWindow as any })
  const snapshot = { transferId: 'transfer', panel: { id: 'editor', type: 'editor', isDirty: true, unsavedContent: 'accepted bytes' }, terminalPtyId: 'pty' }
  const pending = h.handlers.get(DRAG_DETACH)!({ window: { id: 1 } }, snapshot, 'ws')
  h.handlers.get(PANEL_TRANSFER_READY)!({ window: win }, 'transfer')
  await pending
  expect(h.handlers.get(PANEL_TRANSFER_COMMIT)!({ window: { id: 1 } }, 'transfer', snapshot)).toBe(true)
  return snapshot
}
it('caches COMMIT without adopting resources, then adopts once FINISH arrives and releases recovery on ACK', async () => {
  const win = receiver(2)
  const snapshot = await commitTo(win)
  expect(h.cache).toHaveBeenCalledWith(2, expect.objectContaining({ panels: { editor: snapshot.panel } }))
  expect(h.retain).toHaveBeenCalledWith(2)
  expect(h.target).not.toHaveBeenCalled()
  expect(h.send.mock.calls.some(call => call[1] === PANEL_RECEIVE)).toBe(false)
  h.handlers.get(PANEL_TRANSFER_FINISH)!({ window: { id: 1 } }, 'transfer', { ...snapshot, terminalScrollback: 'latest replay' })
  h.handlers.get(PANEL_TRANSFER_FINISH)!({ window: { id: 1 } }, 'transfer')
  expect(h.target).toHaveBeenCalledTimes(1)
  expect(h.send).toHaveBeenCalledWith(2, PANEL_RECEIVE, expect.objectContaining({ ...snapshot, terminalScrollback: 'latest replay' }))
  h.handlers.get(PANEL_TRANSFER_READY)!({ window: { id: 99 } }, 'transfer', 'received')
  expect(h.clear).not.toHaveBeenCalled()
  h.handlers.get(PANEL_TRANSFER_READY)!({ window: win }, 'transfer', 'received')
  h.handlers.get(PANEL_TRANSFER_READY)!({ window: win }, 'transfer', 'received')
  expect(h.clear).toHaveBeenCalledTimes(1)
  expect(h.clear).toHaveBeenCalledWith(2)
})
it('retains a closed committed receiver when recreation fails', async () => {
  const win = receiver(2)
  const create = vi.fn().mockReturnValueOnce(win).mockImplementation(() => { throw new Error('native window failed') })
  await commitTo(win, create)
  win.close()
  h.handlers.get(PANEL_TRANSFER_FINISH)!({ window: { id: 1 } }, 'transfer')
  expect(create).toHaveBeenCalledTimes(2)
  expect(h.clear).not.toHaveBeenCalled()
  expect(h.target).not.toHaveBeenCalled()
})
it('retains the replacement before releasing the closed receiver and awaits its adoption ACK', async () => {
  const original = receiver(2)
  const replacement = receiver(3)
  const create = vi.fn().mockReturnValueOnce(original).mockReturnValueOnce(replacement)
  await commitTo(original, create)
  original.close()
  h.handlers.get(PANEL_TRANSFER_FINISH)!({ window: { id: 1 } }, 'transfer')
  expect(h.retain).toHaveBeenLastCalledWith(3)
  expect(h.clear).toHaveBeenCalledWith(2)
  expect(h.retain.mock.invocationCallOrder[1]).toBeLessThan(h.clear.mock.invocationCallOrder[0])
  expect(h.target).not.toHaveBeenCalled()
  replacement.webContents.emit('did-finish-load')
  expect(h.send).toHaveBeenCalledWith(3, PANEL_RECEIVE, expect.objectContaining({ transferId: 'transfer' }))
  h.handlers.get(PANEL_TRANSFER_READY)!({ window: replacement }, 'transfer', 'received')
  expect(h.clear).toHaveBeenLastCalledWith(3)
})

it('does not report an existing-window drop claimed until receiver hydration is acknowledged', async () => {
  const win = receiver(2)
  registerDragHandlers({ createWindow: () => win as any })
  await h.handlers.get(CROSS_WINDOW_DRAG_START)!({ window: { id: 1 } }, { terminalPtyId: 'pty', panel: { id: 'editor', type: 'editor', title: 'Editor' }, geometry: { size: { width: 500, height: 400 } } })
  const reserved = await h.handlers.get(CROSS_WINDOW_DRAG_DROP)!({ window: win, sender: { window: win } }, 'editor')
  expect(h.crossTransfer).toHaveBeenCalledWith('pty', 2) // armed before renderer can reconnect/ACK
  let settled = false
  const result = h.handlers.get(CROSS_WINDOW_DRAG_RESOLVE)!().then((value: unknown) => { settled = true; return value })
  await Promise.resolve(); await Promise.resolve()
  expect(settled).toBe(false)
  expect(reserved.transferId).toEqual(expect.any(String))
  await h.handlers.get(PANEL_TRANSFER_READY)!({ window: win }, reserved.transferId, 'received')
  expect(await result).toEqual({ claimed: true })
})

it('keeps source ownership when an existing target closes before acknowledging hydration', async () => {
  const win = receiver(2)
  registerDragHandlers({ createWindow: () => win as any })
  await h.handlers.get(CROSS_WINDOW_DRAG_START)!({ window: { id: 1 } }, { terminalPtyId: 'pty', panel: { id: 'editor', type: 'editor', title: 'Editor' }, geometry: { size: { width: 500, height: 400 } } })
  await h.handlers.get(CROSS_WINDOW_DRAG_DROP)!({ window: win }, 'editor')
  expect(h.crossTransfer).toHaveBeenCalledWith('pty', 2)
  const result = h.handlers.get(CROSS_WINDOW_DRAG_RESOLVE)!()
  win.close()
  expect(await result).toEqual({ claimed: false })
  expect(h.abort).toHaveBeenCalledWith('pty')
})
