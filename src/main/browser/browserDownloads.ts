import { app, shell, type DownloadItem, type WebContents } from 'electron'
import fs from 'fs'
import path from 'path'
import { BROWSER_DOWNLOADS_CHANGED } from '../../shared/ipc-channels'
import type { BrowserTargetIdentity } from './browserRuntime'
import type { BrowserDownloadEntry } from '../../shared/types'

const COMPLETED_DOWNLOADS_PER_OWNER = 20
interface TrackedDownload {
  entry: BrowserDownloadEntry
  item?: DownloadItem
  dispose(): void
}
interface DownloadGroup {
  host: WebContents
  target?: BrowserTargetIdentity
  downloads: TrackedDownload[]
}
const downloadsByWebContents = new Map<number, DownloadGroup>()
const guestTargets = new WeakMap<WebContents, BrowserTargetIdentity>()
const watchedOwners = new WeakSet<WebContents>()
const watchedSessions = new WeakSet<Electron.Session>()
let nextDownloadId = 1

export function bindBrowserDownloadOwner(guest: WebContents, target: BrowserTargetIdentity): void {
  guestTargets.set(guest, target)
  const group = downloadsByWebContents.get(guest.id)
  if (group && group.host.id === guest.hostWebContents?.id) group.target = target
}
export function ownsBrowserDownloads(senderId: number, guestId: number, target: BrowserTargetIdentity): boolean {
  const group = downloadsByWebContents.get(guestId)
  return group?.host.id === senderId && !!group.target &&
    group.target.workspaceId === target.workspaceId && group.target.panelId === target.panelId && group.target.tabId === target.tabId
}
function downloadsSnapshot(webContentsId: number): BrowserDownloadEntry[] {
  return (downloadsByWebContents.get(webContentsId)?.downloads ?? []).map(({ entry }) => ({ ...entry }))
}
function notifyRenderer(id: number, group: DownloadGroup): void {
  try { group.host.send(BROWSER_DOWNLOADS_CHANGED, { webContentsId: id, downloads: downloadsSnapshot(id) }) }
  catch { /* owner gone */ }
}
function trackOwner(host: WebContents): void {
  if (watchedOwners.has(host)) return
  watchedOwners.add(host)
  host.once?.('destroyed', () => {
    for (const [id, group] of downloadsByWebContents) {
      if (group.host !== host) continue
      downloadsByWebContents.delete(id)
      for (const tracked of group.downloads) { tracked.dispose(); tracked.item?.cancel(); tracked.item = undefined }
    }
  })
}
function pruneCompleted(host: WebContents): void {
  const completed: Array<{ id: number; group: DownloadGroup; tracked: TrackedDownload }> = []
  for (const [id, group] of downloadsByWebContents) {
    if (group.host !== host) continue
    for (const tracked of group.downloads) if (!tracked.item) completed.push({ id, group, tracked })
  }
  completed.sort((a, b) => a.tracked.entry.at - b.tracked.entry.at)
  for (const { id, group, tracked } of completed.slice(0, -COMPLETED_DOWNLOADS_PER_OWNER)) {
    group.downloads.splice(group.downloads.indexOf(tracked), 1)
    if (!group.downloads.length) downloadsByWebContents.delete(id)
    notifyRenderer(id, group)
  }
}

export function watchDownloadsForSession(session: Electron.Session): void {
  if (watchedSessions.has(session)) return
  watchedSessions.add(session)
  session.on('will-download', (_event, item, guest) => {
    const id = guest?.id
    const host = guest?.hostWebContents
    if (id === undefined || !host) return
    trackOwner(host)
    // Browser panels use embedded guests, so choose a deterministic,
    // collision-free destination without opening a modal over the canvas.
    const downloadDir = process.env.CATE_E2E === '1'
      ? path.join(app.getPath('temp'), 'cate-e2e-downloads')
      : path.join(app.getPath('downloads'), 'Cate')
    fs.mkdirSync(downloadDir, { recursive: true })
    const filename = path.basename(item.getFilename() || 'download')
    item.setSavePath(path.join(downloadDir, `${Date.now()}-${filename}`))
    const group = downloadsByWebContents.get(id) ?? { host, target: guestTargets.get(guest), downloads: [] }
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
    const tracked: TrackedDownload = { entry, item, dispose: () => {
      item.removeListener('updated', updated)
      item.removeListener('done', done)
    } }
    group.downloads.push(tracked)
    downloadsByWebContents.set(id, group)
    notifyRenderer(id, group)
    const updated = (_event: Electron.Event, state: string): void => {
      entry.state = (state === 'progressing' && item.isPaused() ? 'paused' : state) as BrowserDownloadEntry['state']
      entry.receivedBytes = item.getReceivedBytes()
      entry.totalBytes = item.getTotalBytes()
      notifyRenderer(id, group)
    }
    const done = (_event: Electron.Event, state: string): void => {
      entry.state = state as BrowserDownloadEntry['state']
      entry.filePath = item.getSavePath()
      entry.receivedBytes = item.getReceivedBytes()
      entry.totalBytes = item.getTotalBytes()
      tracked.dispose()
      tracked.item = undefined
      tracked.dispose = () => {}
      pruneCompleted(host)
      notifyRenderer(id, group)
    }
    item.on('updated', updated)
    item.once('done', done)
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
    ?.downloads.find(({ entry }) => entry.id === downloadId)
  if (!tracked) return { error: 'download-not-found' }

  if (action === 'cancel') {
    if (tracked.entry.state !== 'progressing' && tracked.entry.state !== 'paused') {
      return { error: 'download-not-active' }
    }
    tracked.item?.cancel()
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
