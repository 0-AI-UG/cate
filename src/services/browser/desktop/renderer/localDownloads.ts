// Downloads made by this client's webviews. Desktop main reports them per
// guest; they are recorded with the runtime (`browserData.recordDownload`) for
// the panel that owns the guest, so every client lists them. A finished
// download is uploaded to the runtime's `browser/downloads/` (spec 10.2), so
// agents find it; the recorded entry names that runtime path. Only this
// client can open, reveal or cancel them.

import type { CapabilityProxy } from '@kernel/rpc/contract'
import type { BrowserDownloadAction, BrowserDownloadEntry, BrowserPageBridge, browserDataCapability } from '../../contract'

export interface DownloadOwner {
  panelId: string
  browserData: CapabilityProxy<typeof browserDataCapability>
  /** Stores a finished download in the runtime (`file.storeDownload`). */
  storeDownload(filename: string, bytes: Uint8Array): Promise<{ path: string }>
}

export interface LocalDownloads {
  /** Remembers which panel a guest belongs to; kept after the view unmounts
   *  so a running download still lands on its panel. */
  ownGuest(webContentsId: number, owner: DownloadOwner): void
  isLocal(id: string): boolean
  /** Changes whenever a local download changes. */
  version(): number
  subscribe(listener: () => void): () => void
  act(id: string, action: BrowserDownloadAction): Promise<unknown>
}

export function createLocalDownloads(bridge: BrowserPageBridge): LocalDownloads {
  const owners = new Map<number, DownloadOwner>()
  /** download id -> the guest that made it. */
  const local = new Map<string, number>()
  const listeners = new Set<() => void>()
  /** download id -> its path in the runtime, once uploaded ('' while uploading or failed). */
  const stored = new Map<string, string>()
  let version = 0

  /** The entry as the runtime sees it: its file is the uploaded copy, not
   *  this client's local file. */
  const record = (owner: DownloadOwner, entry: BrowserDownloadEntry): void => {
    const filePath = stored.get(entry.id) ?? ''
    void owner.browserData.recordDownload({ panelId: owner.panelId, entry: { ...entry, filePath } }).catch(() => { /* offline */ })
  }

  const upload = async (owner: DownloadOwner, webContentsId: number, entry: BrowserDownloadEntry): Promise<void> => {
    try {
      const bytes = await bridge.readDownload(webContentsId, entry.id)
      if (!bytes) return
      const { path } = await owner.storeDownload(entry.filename, bytes)
      stored.set(entry.id, path)
      record(owner, entry)
    } catch {
      // Offline or too large: the download stays on this client only.
    }
  }

  bridge.onDownloads(({ webContentsId, downloads }) => {
    const owner = owners.get(webContentsId)
    if (!owner) return
    for (const entry of downloads) {
      local.set(entry.id, webContentsId)
      if (entry.state === 'completed' && !stored.has(entry.id)) {
        stored.set(entry.id, '')
        void upload(owner, webContentsId, entry)
      }
      record(owner, entry)
    }
    version++
    for (const listener of [...listeners]) listener()
  })

  return {
    ownGuest: (webContentsId, owner) => { owners.set(webContentsId, owner) },
    isLocal: (id) => local.has(id),
    version: () => version,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    act(id, action) {
      const webContentsId = local.get(id)
      if (webContentsId === undefined) return Promise.resolve({ error: 'download-not-found' })
      return bridge.downloadAction(webContentsId, id, action)
    },
  }
}
