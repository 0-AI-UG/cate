import { ipcMain } from 'electron'
import { BROWSER_ENGINE_CHANNELS as C, type BrowserSurfaceConnection, type BrowserSurfaceOptions } from '../../contract/engine'
import type { createBrowserEngineHost } from './host'

export function registerBrowserEngineIpc(engine: ReturnType<typeof createBrowserEngineHost>, prepared: (partition: string) => boolean): void {
  let nextPageId = 0
  const owners = new Map<number, Set<number>>()
  engine.onExit(() => { for (const pages of owners.values()) pages.clear() })
  ipcMain.on(C.focus, (event, id: number, focused: boolean) => engine.focus(id, event.sender.id, focused))
  ipcMain.handle(C.icon, (_event, partition: string, url: string) => {
    if (!prepared(partition) || typeof url !== 'string' || url.length > 32768) return null
    return engine.call('icon', { partition, url })
  })
  ipcMain.handle(C.create, async (event, options: BrowserSurfaceOptions) => {
    if (!options || !prepared(options.partition)) throw new Error('browser-partition-not-prepared')
    const surface = await engine.call<BrowserSurfaceConnection>('create', { ...options, id: ++nextPageId, ownerId: event.sender.id })
    if (event.sender.isDestroyed()) { await engine.call('close', { id: surface.id }); throw new Error('browser-owner-closed') }
    engine.own(surface.id, event.sender.id)
    engine.trackOwner(event.sender)
    let pages = owners.get(event.sender.id)
    if (!pages) {
      pages = new Set(); owners.set(event.sender.id, pages)
      event.sender.once('destroyed', () => {
        for (const id of owners.get(event.sender.id) ?? []) engine.forget(id)
        owners.delete(event.sender.id)
        void engine.call('releaseOwner', { ownerId: event.sender.id }).catch(() => {})
      })
    }
    pages.add(surface.id)
    return surface
  })
  ipcMain.handle(C.close, async (event, id: number) => {
    if (!engine.owns(id, event.sender.id)) return
    owners.get(event.sender.id)?.delete(id)
    engine.forget(id)
    await engine.call('close', { id })
  })
}
