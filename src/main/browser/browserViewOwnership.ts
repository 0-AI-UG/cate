import type { BrowserWindow } from 'electron'

const owners = new Map<number, BrowserWindow>()

export function registerBrowserViewOwner(webContentsId: number, owner: BrowserWindow): void {
  owners.set(webContentsId, owner)
}

export function unregisterBrowserViewOwner(webContentsId: number): void {
  owners.delete(webContentsId)
}

export function browserViewOwner(webContentsId: number): BrowserWindow | null {
  const owner = owners.get(webContentsId)
  if (!owner || owner.isDestroyed()) {
    owners.delete(webContentsId)
    return null
  }
  return owner
}
