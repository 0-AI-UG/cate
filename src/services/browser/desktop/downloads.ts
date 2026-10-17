// Downloads of browser guests on this client. Each download is tracked per
// guest webContents and reported to the window hosting it; the view records
// the entries with the runtime (`browserData.recordDownload`) so every client
// shows them. Only the hosting window may act on a guest's downloads.

import { shell, type DownloadItem, type Session, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserDownloadAction, BrowserDownloadEntry } from '../contract'

const COMPLETED_DOWNLOADS_PER_HOST = 20
/** Downloads up to this size are copied to the runtime. */
const MAX_STORED_DOWNLOAD_BYTES = 512 * 1024 * 1024

interface TrackedDownload {
  entry: BrowserDownloadEntry
  item?: DownloadItem
  dispose(): void
}

interface DownloadGroup {
  host: WebContents
  downloads: TrackedDownload[]
}

export interface GuestDownloadsDeps {
  /** Where downloads are saved on this machine. */
  downloadDir(): string
  notify(host: WebContents, event: { webContentsId: number; downloads: BrowserDownloadEntry[] }): void
}

export class GuestDownloads {
  private readonly groups = new Map<number, DownloadGroup>()
  private readonly hosts = new WeakSet<WebContents>()
  private readonly sessions = new WeakSet<Session>()

  constructor(private readonly deps: GuestDownloadsDeps) {}

  list(webContentsId: number): BrowserDownloadEntry[] {
    return (this.groups.get(webContentsId)?.downloads ?? []).map(({ entry }) => ({ ...entry }))
  }

  /** Tracks every download of a partition's guests. Idempotent. */
  watch(session: Session): void {
    if (this.sessions.has(session)) return
    this.sessions.add(session)
    session.on('will-download', (_event, item, guest) => this.track(item, guest))
  }

  async act(hostId: number, webContentsId: number, downloadId: string, action: BrowserDownloadAction): Promise<{ ok?: true; error?: string }> {
    const group = this.groups.get(webContentsId)
    if (!group || group.host.id !== hostId) return { error: 'download-owner-mismatch' }
    const tracked = group.downloads.find(({ entry }) => entry.id === downloadId)
    if (!tracked) return { error: 'download-not-found' }
    if (action === 'cancel') {
      if (tracked.entry.state !== 'progressing' && tracked.entry.state !== 'paused') return { error: 'download-not-active' }
      tracked.item?.cancel()
      return { ok: true }
    }
    if (tracked.entry.state !== 'completed' || !tracked.entry.filePath) return { error: 'download-not-complete' }
    if (action === 'show') {
      shell.showItemInFolder(tracked.entry.filePath)
      return { ok: true }
    }
    const error = await shell.openPath(tracked.entry.filePath)
    return error ? { error } : { ok: true }
  }

  /** A completed download's bytes, for the hosting window to upload to its
   *  runtime. Larger files stay on this client. */
  async read(hostId: number, webContentsId: number, downloadId: string): Promise<Uint8Array | null> {
    const group = this.groups.get(webContentsId)
    if (!group || group.host.id !== hostId) return null
    const tracked = group.downloads.find(({ entry }) => entry.id === downloadId)
    if (tracked?.entry.state !== 'completed' || !tracked.entry.filePath) return null
    try {
      const stat = await fs.promises.stat(tracked.entry.filePath)
      if (!stat.isFile() || stat.size > MAX_STORED_DOWNLOAD_BYTES) return null
      return new Uint8Array(await fs.promises.readFile(tracked.entry.filePath))
    } catch {
      return null
    }
  }

  private notify(id: number, group: DownloadGroup): void {
    try { this.deps.notify(group.host, { webContentsId: id, downloads: this.list(id) }) } catch { /* host gone */ }
  }

  private trackHost(host: WebContents): void {
    if (this.hosts.has(host)) return
    this.hosts.add(host)
    host.once?.('destroyed', () => {
      for (const [id, group] of this.groups) {
        if (group.host !== host) continue
        this.groups.delete(id)
        for (const tracked of group.downloads) { tracked.dispose(); tracked.item?.cancel(); tracked.item = undefined }
      }
    })
  }

  private pruneCompleted(host: WebContents): void {
    const completed: Array<{ id: number; group: DownloadGroup; tracked: TrackedDownload }> = []
    for (const [id, group] of this.groups) {
      if (group.host !== host) continue
      for (const tracked of group.downloads) if (!tracked.item) completed.push({ id, group, tracked })
    }
    completed.sort((a, b) => a.tracked.entry.at - b.tracked.entry.at)
    for (const { id, group, tracked } of completed.slice(0, -COMPLETED_DOWNLOADS_PER_HOST)) {
      group.downloads.splice(group.downloads.indexOf(tracked), 1)
      if (!group.downloads.length) this.groups.delete(id)
      this.notify(id, group)
    }
  }

  private track(item: DownloadItem, guest: WebContents | undefined): void {
    const id = guest?.id
    const host = guest?.hostWebContents
    if (id === undefined || !host) return
    this.trackHost(host)
    // Guests are embedded, so pick a deterministic, collision-free destination
    // instead of a modal over the canvas.
    const dir = this.deps.downloadDir()
    fs.mkdirSync(dir, { recursive: true })
    const filename = path.basename(item.getFilename() || 'download')
    item.setSavePath(path.join(dir, `${Date.now()}-${filename}`))
    const group = this.groups.get(id) ?? { host, downloads: [] }
    const entry: BrowserDownloadEntry = {
      id: `download-${randomUUID()}`,
      url: item.getURL(),
      filename,
      filePath: item.getSavePath(),
      state: 'progressing',
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      at: Date.now(),
    }
    const updated = (_event: Electron.Event, state: string): void => {
      entry.state = (state === 'progressing' && item.isPaused() ? 'paused' : state) as BrowserDownloadEntry['state']
      entry.receivedBytes = item.getReceivedBytes()
      entry.totalBytes = item.getTotalBytes()
      this.notify(id, group)
    }
    const done = (_event: Electron.Event, state: string): void => {
      entry.state = state as BrowserDownloadEntry['state']
      entry.filePath = item.getSavePath()
      entry.receivedBytes = item.getReceivedBytes()
      entry.totalBytes = item.getTotalBytes()
      tracked.dispose()
      tracked.item = undefined
      tracked.dispose = () => {}
      this.pruneCompleted(host)
      this.notify(id, group)
    }
    const tracked: TrackedDownload = {
      entry,
      item,
      dispose: () => {
        item.removeListener('updated', updated)
        item.removeListener('done', done)
      },
    }
    group.downloads.push(tracked)
    this.groups.set(id, group)
    this.notify(id, group)
    item.on('updated', updated)
    item.once('done', done)
  }
}
