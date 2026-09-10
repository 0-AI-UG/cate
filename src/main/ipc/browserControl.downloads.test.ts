import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ handlers: new Map<string, Function>(), guest: null as any, open: vi.fn(async () => '') }))
vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' }, shell: { openPath: h.open, showItemInFolder: vi.fn() },
  webContents: { fromId: () => h.guest }, BrowserWindow: { fromWebContents: () => ({ id: 7 }) },
  ipcMain: { on: vi.fn(), handle: (channel: string, handler: Function) => h.handlers.set(channel, handler) },
}))
vi.mock('fs', () => ({ default: { mkdirSync: vi.fn() } }))
vi.mock('../logger', () => ({ default: { warn: vi.fn(), error: vi.fn() } }))
vi.mock('../browser/browserRuntime', () => ({ browserRuntime: { attach: vi.fn(), isRegistered: () => true } }))
vi.mock('../browser/browserUpload', () => ({ authorizeBrowserUpload: vi.fn() }))
vi.mock('../browser/browserCodeExecution', () => ({ assertBrowserCodeCell: vi.fn() }))
import { registerBrowserControlHandlers } from './browserControl'
import { watchDownloadsForSession, downloadsForWebContents } from '../browser/browserDownloads'
import { BROWSER_CONTROL } from '../../shared/ipc-channels'

it('authorizes completed download actions by surviving owner after its guest is destroyed', async () => {
  registerBrowserControlHandlers()
  const host = Object.assign(new EventEmitter(), { id: 42, send: vi.fn(), isDestroyed: () => false })
  const session = new EventEmitter()
  const guest = { id: 901, hostWebContents: host, session, isDestroyed: () => false, getType: () => 'webview' }
  h.guest = guest
  const target = { workspaceId: 'w', panelId: 'p', tabId: 't', webContentsId: 901 }
  await h.handlers.get(BROWSER_CONTROL)!({ sender: host }, { op: 'attach', ...target })
  watchDownloadsForSession(session as Electron.Session)
  let destination = ''
  const item = Object.assign(new EventEmitter(), {
    getFilename: () => 'file.zip', getURL: () => 'https://example.com/file.zip',
    setSavePath: (value: string) => { destination = value }, getSavePath: () => destination,
    getReceivedBytes: () => 1, getTotalBytes: () => 1, isPaused: () => false, cancel: vi.fn(),
  })
  session.emit('will-download', {}, item, guest)
  item.emit('done', {}, 'completed')
  const id = downloadsForWebContents(901)[0].id
  h.guest = null
  const request = { op: 'downloadAction', ...target, method: 'open', args: { downloadId: id } }
  expect(await h.handlers.get(BROWSER_CONTROL)!({ sender: host }, request)).toEqual({ ok: true })
  expect(h.open).toHaveBeenCalledWith(destination)
  h.open.mockClear()
  expect(await h.handlers.get(BROWSER_CONTROL)!({ sender: { id: 99 } }, request)).toHaveProperty('error')
  expect(h.open).not.toHaveBeenCalled()
  host.emit('destroyed')
  expect(downloadsForWebContents(901)).toEqual([])
})

it('starts a download only through the attached target guest', async () => {
  registerBrowserControlHandlers()
  const host = Object.assign(new EventEmitter(), { id: 42, send: vi.fn(), isDestroyed: () => false })
  const session = new EventEmitter()
  const downloadURL = vi.fn()
  h.guest = {
    id: 902, hostWebContents: host, session, downloadURL,
    isDestroyed: () => false, getType: () => 'webview',
  }
  const target = { workspaceId: 'w', panelId: 'p', tabId: 't', webContentsId: 902 }
  const handler = h.handlers.get(BROWSER_CONTROL)!

  expect(await handler({ sender: host }, { op: 'attach', ...target })).toEqual({ ok: true })
  expect(await handler({ sender: host }, { op: 'download', ...target, args: { url: 'https://example.com/image.png' } }))
    .toEqual({ ok: true })
  expect(downloadURL).toHaveBeenCalledWith('https://example.com/image.png')
  expect(await handler({ sender: host }, { op: 'download', ...target, args: {} })).toEqual({ error: 'url-required' })
})
