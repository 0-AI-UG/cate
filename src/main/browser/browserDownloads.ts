import { app, shell, type DownloadItem, type WebContents } from 'electron'
import fs from 'fs'
import path from 'path'
import { BROWSER_DOWNLOADS_CHANGED } from '../../shared/ipc-channels'
import type { BrowserDownloadEntry } from '../../shared/types'

const DOWNLOADS_PER_GUEST = 20
interface TrackedDownload {
  entry: BrowserDownloadEntry
  item: DownloadItem
}

const downloadsByWebContents = new Map<number, TrackedDownload[]>()
const watchedSessions = new WeakSet<Electron.Session>()
let nextDownloadId = 1

function downloadsSnapshot(webContentsId: number): BrowserDownloadEntry[] {
  return (downloadsByWebContents.get(webContentsId) ?? []).map(({ entry }) => ({ ...entry }))
}

function notifyRenderer(guest: WebContents): void {
  try {
    guest.hostWebContents?.send(BROWSER_DOWNLOADS_CHANGED, {
      webContentsId: guest.id,
      downloads: downloadsSnapshot(guest.id),
    })
  } catch {
    // The host may disappear while a download is finishing.
  }
}

export function watchDownloadsForSession(session: Electron.Session): void {
  if (watchedSessions.has(session)) return
  watchedSessions.add(session)
  session.on('will-download', (_event, item, guest) => {
    const id = guest?.id
    if (id === undefined) return
    // Browser panels use embedded guests, so choose a deterministic,
    // collision-free destination without opening a modal over the canvas.
    const downloadDir = process.env.CATE_E2E === '1'
      ? path.join(app.getPath('temp'), 'cate-e2e-downloads')
      : path.join(app.getPath('downloads'), 'Cate')
    fs.mkdirSync(downloadDir, { recursive: true })
    const filename = path.basename(item.getFilename() || 'download')
    item.setSavePath(path.join(downloadDir, `${Date.now()}-${filename}`))
    const list = downloadsByWebContents.get(id) ?? []
    const entry: BrowserDownloadEntry = {
      id: `download-${nextDownloadId++}`,
      url: item.getURL(),
      filename,
      filePath: item.getSavePath(),
      state: 'progressing',
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      at: Date.now(),
    }
    list.push({ entry, item })
    while (list.length > DOWNLOADS_PER_GUEST) list.shift()
    downloadsByWebContents.set(id, list)
    notifyRenderer(guest)
    item.on('updated', (_updatedEvent, state) => {
      entry.state = state === 'progressing' && item.isPaused() ? 'paused' : state
      entry.receivedBytes = item.getReceivedBytes()
      entry.totalBytes = item.getTotalBytes()
      notifyRenderer(guest)
    })
    item.once('done', (_doneEvent, state) => {
      entry.state = state
      entry.filePath = item.getSavePath()
      entry.receivedBytes = item.getReceivedBytes()
      entry.totalBytes = item.getTotalBytes()
      notifyRenderer(guest)
    })
  })
}

export function downloadsForWebContents(webContentsId: number): BrowserDownloadEntry[] {
  return downloadsSnapshot(webContentsId)
}

export async function actOnBrowserDownload(
  webContentsId: number,
  downloadId: string,
  action: 'cancel' | 'open' | 'show',
): Promise<{ ok?: true; error?: string }> {
  const tracked = downloadsByWebContents.get(webContentsId)
    ?.find(({ entry }) => entry.id === downloadId)
  if (!tracked) return { error: 'download-not-found' }

  if (action === 'cancel') {
    if (tracked.entry.state !== 'progressing' && tracked.entry.state !== 'paused') {
      return { error: 'download-not-active' }
    }
    tracked.item.cancel()
    return { ok: true }
  }
  if (tracked.entry.state !== 'completed' || !tracked.entry.filePath) {
    return { error: 'download-not-complete' }
  }
  if (action === 'show') {
    shell.showItemInFolder(tracked.entry.filePath)
    return { ok: true }
  }
  const error = await shell.openPath(tracked.entry.filePath)
  return error ? { error } : { ok: true }
}
