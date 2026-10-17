import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  send: vi.fn(),
  mkdirSync: vi.fn(),
  openPath: vi.fn(async () => ''),
  showItemInFolder: vi.fn(),
}))

vi.mock('electron', () => ({
  shell: { openPath: h.openPath, showItemInFolder: h.showItemInFolder },
}))
vi.mock('node:fs', () => ({ default: { mkdirSync: h.mkdirSync } }))

import { GuestDownloads } from './downloads'

const HOST_ID = 5
const downloads = new GuestDownloads({
  downloadDir: () => '/tmp/downloads',
  notify: (host, event) => (host as unknown as { send: typeof h.send }).send('downloads', event),
})
const downloadsForWebContents = (id: number) => downloads.list(id)
const actOnBrowserDownload = (id: number, downloadId: string, action: 'cancel' | 'open' | 'show') => downloads.act(HOST_ID, id, downloadId, action)

function setupDownload(webContentsId: number) {
  const session = new EventEmitter()
  const item = new EventEmitter() as EventEmitter & {
    getFilename: () => string
    getURL: () => string
    getSavePath: () => string
    setSavePath: (path: string) => void
    getReceivedBytes: () => number
    getTotalBytes: () => number
    isPaused: () => boolean
    cancel: () => void
  }
  let receivedBytes = 0
  let savePath = ''
  Object.assign(item, {
    getFilename: () => 'archive.zip',
    getURL: () => 'https://example.com/archive.zip',
    getSavePath: () => savePath,
    setSavePath: (value: string) => { savePath = value },
    getReceivedBytes: () => receivedBytes,
    getTotalBytes: () => 100,
    isPaused: () => false,
    cancel: vi.fn(),
  })
  const guest = { id: webContentsId, hostWebContents: { id: HOST_ID, send: h.send } }
  downloads.watch(session as unknown as Electron.Session)
  session.emit('will-download', {}, item, guest)
  return { item, guest, setReceivedBytes: (value: number) => { receivedBytes = value } }
}

describe('guest downloads', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports download progress and completion to the owning renderer', async () => {
    const { item, setReceivedBytes } = setupDownload(71)
    const [started] = downloadsForWebContents(71)
    expect(started).toMatchObject({
      filename: 'archive.zip',
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: 100,
    })
    expect(h.send).toHaveBeenCalledWith('downloads', expect.objectContaining({
      webContentsId: 71,
    }))

    setReceivedBytes(50)
    item.emit('updated', {}, 'progressing')
    expect(downloadsForWebContents(71)[0]).toMatchObject({ receivedBytes: 50, state: 'progressing' })

    setReceivedBytes(100)
    item.emit('done', {}, 'completed')
    const [completed] = downloadsForWebContents(71)
    expect(completed).toMatchObject({ receivedBytes: 100, state: 'completed' })

    await expect(actOnBrowserDownload(71, completed.id, 'open')).resolves.toEqual({ ok: true })
    expect(h.openPath).toHaveBeenCalledWith(completed.filePath)
    await expect(actOnBrowserDownload(71, completed.id, 'show')).resolves.toEqual({ ok: true })
    expect(h.showItemInFolder).toHaveBeenCalledWith(completed.filePath)
  })

  it('cancels an active download', async () => {
    const { item } = setupDownload(72)
    const [download] = downloadsForWebContents(72)

    await expect(actOnBrowserDownload(72, download.id, 'cancel')).resolves.toEqual({ ok: true })
    expect(item.cancel).toHaveBeenCalledOnce()
  })
})

it('retains all active downloads beyond the completed history cap', async () => {
  const first = setupDownload(90)
  const firstId = downloadsForWebContents(90)[0].id
  for (let index = 0; index < 20; index++) setupDownload(90)
  expect(downloadsForWebContents(90)).toHaveLength(21)
  await expect(actOnBrowserDownload(90, firstId, 'cancel')).resolves.toEqual({ ok: true })
  expect(first.item.cancel).toHaveBeenCalledOnce()
})
it('refuses actions from a window that does not host the guest', async () => {
  setupDownload(92)
  const [download] = downloadsForWebContents(92)
  await expect(downloads.act(HOST_ID + 1, 92, download.id, 'cancel')).resolves.toEqual({ error: 'download-owner-mismatch' })
})
it('delivers completion through the captured owner after the guest loses its host', () => {
  const { item, guest } = setupDownload(91)
  h.send.mockClear()
  Object.assign(guest, { hostWebContents: undefined })
  item.emit('done', {}, 'completed')
  expect(h.send).toHaveBeenCalledWith('downloads', expect.objectContaining({
    webContentsId: 91, downloads: [expect.objectContaining({ state: 'completed' })],
  }))
  expect(item.listenerCount('updated')).toBe(0)
})
