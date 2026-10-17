// Every app window: main windows and the native windows of detached document
// windows. Routing to a window goes through here. Takes window-like objects so
// it tests without Electron.

import type { DesktopWindowKind, DetachedWindowRef } from '../contract'

export interface RegistryWindow {
  readonly id: number
  readonly webContents: { readonly id: number; send(channel: string, ...args: unknown[]): void }
  isDestroyed(): boolean
  isFocused(): boolean
  on(event: 'focus' | 'closed', listener: () => void): unknown
}

interface WindowEntry<W extends RegistryWindow = RegistryWindow> {
  win: W
  kind: DesktopWindowKind
  /** Set for a detached window. */
  ref?: DetachedWindowRef
}

const detachedKey = (ref: DetachedWindowRef): string => `${ref.workspaceId}\u0000${ref.windowId}`

export class WindowRegistry<W extends RegistryWindow = RegistryWindow> {
  private readonly entries = new Map<number, WindowEntry<W>>()
  private readonly byContents = new Map<number, number>()
  private readonly detached = new Map<string, number>()
  private readonly closedListeners = new Set<(entry: WindowEntry<W>) => void>()
  private lastFocusedMain: number | null = null

  register(win: W, kind: DesktopWindowKind, ref?: DetachedWindowRef): void {
    const id = win.id
    const contentsId = win.webContents.id
    const entry: WindowEntry<W> = { win, kind, ...(ref ? { ref } : {}) }
    this.entries.set(id, entry)
    this.byContents.set(contentsId, id)
    if (ref) this.detached.set(detachedKey(ref), id)
    if (kind === 'main') this.lastFocusedMain = id
    win.on('focus', () => { if (kind === 'main') this.lastFocusedMain = id })
    win.on('closed', () => {
      for (const listener of [...this.closedListeners]) {
        try { listener(entry) } catch { /* a listener must not block cleanup */ }
      }
      this.entries.delete(id)
      this.byContents.delete(contentsId)
      if (ref && this.detached.get(detachedKey(ref)) === id) this.detached.delete(detachedKey(ref))
      if (this.lastFocusedMain === id) this.lastFocusedMain = null
    })
  }

  onClosed(listener: (entry: WindowEntry<W>) => void): () => void {
    this.closedListeners.add(listener)
    return () => { this.closedListeners.delete(listener) }
  }

  get(id: number): WindowEntry<W> | undefined {
    const entry = this.entries.get(id)
    return entry && !entry.win.isDestroyed() ? entry : undefined
  }

  /** The window whose renderer is `webContentsId`. */
  forContents(webContentsId: number): WindowEntry<W> | undefined {
    const id = this.byContents.get(webContentsId)
    return id === undefined ? undefined : this.get(id)
  }

  findDetached(ref: DetachedWindowRef): WindowEntry<W> | undefined {
    const id = this.detached.get(detachedKey(ref))
    return id === undefined ? undefined : this.get(id)
  }

  list(): WindowEntry<W>[] {
    return [...this.entries.values()].filter((entry) => !entry.win.isDestroyed())
  }

  detachedRefs(): DetachedWindowRef[] {
    return this.list().flatMap((entry) => (entry.ref ? [entry.ref] : []))
  }

  /** The main window app-level actions go to: the last focused one, else any. */
  activeMain(): WindowEntry<W> | undefined {
    if (this.lastFocusedMain !== null) {
      const entry = this.get(this.lastFocusedMain)
      if (entry) return entry
    }
    return this.list().find((entry) => entry.kind === 'main')
  }

  focused(): WindowEntry<W> | undefined {
    return this.list().find((entry) => entry.win.isFocused())
  }

  send(id: number, channel: string, ...args: unknown[]): void {
    const entry = this.get(id)
    if (entry) entry.win.webContents.send(channel, ...args)
  }

  broadcast(channel: string, args: unknown[], options: { exceptContents?: number } = {}): void {
    for (const entry of this.list()) {
      if (entry.win.webContents.id === options.exceptContents) continue
      entry.win.webContents.send(channel, ...args)
    }
  }
}
