// Downloads made by this client's webviews. Desktop main reports them per
// guest; they are recorded with the runtime (`browserData.recordDownload`) for
// the panel that owns the guest, so every client lists them. A finished
// download is uploaded to the runtime's `browser/downloads/` (spec 10.2), so
// agents find it; the recorded entry names that runtime path. Only this
// client can open, reveal or cancel them.

import type { BrowserDownloadAction, BrowserDownloadEntry, BrowserPageBridge, browserDataCapability } from '@services/browser/contract'
import type { CapabilityProxy } from '@kernel/rpc/contract'

interface Owner {
  panelId: string
  browserData: CapabilityProxy<typeof browserDataCapability>
  /** Stores a finished download in the runtime (`file.storeDownload`). */
  storeDownload(filename: string, bytes: Uint8Array): Promise<{ path: string }>
}

const owners = new Map<number, Owner>()
/** download id -> the guest that made it. */
const local = new Map<string, number>()
const listeners = new Set<() => void>()
const relayed = new WeakSet<BrowserPageBridge>()
/** download id -> its path in the runtime, once uploaded ('' while uploading or failed). */
const stored = new Map<string, string>()
let version = 0

/** Remembers which panel a guest belongs to; kept after the view unmounts so
 *  a running download still lands on its panel. */
export function ownGuest(webContentsId: number, owner: Owner): void {
  owners.set(webContentsId, owner)
}

export function relayDownloads(bridge: BrowserPageBridge): void {
  if (relayed.has(bridge)) return
  relayed.add(bridge)
  bridge.onDownloads(({ webContentsId, downloads }) => {
    const owner = owners.get(webContentsId)
    if (!owner) return
    for (const entry of downloads) {
      local.set(entry.id, webContentsId)
      if (entry.state === 'completed' && !stored.has(entry.id)) {
        stored.set(entry.id, '')
        void upload(bridge, owner, webContentsId, entry)
      }
      record(owner, entry)
    }
    version++
    for (const listener of [...listeners]) listener()
  })
}

/** The entry as the runtime sees it: its file is the uploaded copy, not this
 *  client's local file. */
function record(owner: Owner, entry: BrowserDownloadEntry): void {
  const filePath = stored.get(entry.id) ?? ''
  void owner.browserData.recordDownload({ panelId: owner.panelId, entry: { ...entry, filePath } }).catch(() => { /* offline */ })
}

async function upload(bridge: BrowserPageBridge, owner: Owner, webContentsId: number, entry: BrowserDownloadEntry): Promise<void> {
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

export function isLocalDownload(id: string): boolean {
  return local.has(id)
}

/** Changes whenever a local download changes. */
export function localDownloadsVersion(): number {
  return version
}

export function subscribeLocalDownloads(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function actOnLocalDownload(bridge: BrowserPageBridge, id: string, action: BrowserDownloadAction): Promise<unknown> {
  const webContentsId = local.get(id)
  if (webContentsId === undefined) return Promise.resolve({ error: 'download-not-found' })
  return bridge.downloadAction(webContentsId, id, action)
}
