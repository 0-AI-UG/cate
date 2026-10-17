// JavaScript dialogs of browser guests. Electron answers a guest's `confirm`
// with false and has no `prompt`, so the guest preload replaces `alert`,
// `confirm` and `prompt` with a synchronous IPC call: the page waits, as it
// would on a native dialog, until the window hosting it (the person, in the
// panel) or the page driver (an agent's `dialog` call) answers. A guest has
// at most one dialog open, since its page is blocked while one is.

import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { BROWSER_GUEST_CHANNELS, BROWSER_PAGE_CHANNELS, type BrowserDialog, type BrowserDialogEvent } from '../contract'

const MAX_TEXT = 10_000

export interface BrowserDialogAnswer {
  accept: boolean
  /** A prompt's answer (its default text when absent). */
  text?: string
}

interface Pending {
  id: string
  dialog: BrowserDialog
  reply(answer: BrowserDialogAnswer): void
}

export class GuestDialogs {
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(webContentsId: number, dialog: BrowserDialog | null) => void>()

  /** The dialog `webContentsId` waits on. */
  current(webContentsId: number): BrowserDialog | undefined {
    return this.pending.get(webContentsId)?.dialog
  }

  /** Calls `listener` whenever a guest's dialog opens (`dialog`) or closes (null). */
  subscribe(listener: (webContentsId: number, dialog: BrowserDialog | null) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Answers the open dialog of `webContentsId`; `id` must name it when given. */
  answer(webContentsId: number, answer: BrowserDialogAnswer, id?: string): BrowserDialog | null {
    const pending = this.pending.get(webContentsId)
    if (!pending || (id !== undefined && pending.id !== id)) return null
    pending.reply(answer)
    return pending.dialog
  }

  /** The guest preload's synchronous dialog call. */
  open(guest: WebContents, raw: unknown, reply: (value: unknown) => void): void {
    const request = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const type = request.type === 'alert' || request.type === 'confirm' || request.type === 'prompt' ? request.type : null
    const none = type === 'confirm' ? false : null
    if (!type || this.pending.has(guest.id) || guest.isDestroyed()) return reply(none)
    const dialog: BrowserDialog = {
      type,
      message: String(request.message ?? '').slice(0, MAX_TEXT),
      ...(type === 'prompt' ? { defaultPrompt: String(request.defaultPrompt ?? '').slice(0, MAX_TEXT) } : {}),
    }
    const id = randomUUID()
    const host = guest.hostWebContents
    const cleanup = (): void => {
      guest.removeListener('did-start-navigation', onNavigation)
      guest.removeListener('destroyed', cancel)
    }
    const settle = (answer: BrowserDialogAnswer): void => {
      if (this.pending.get(guest.id)?.id !== id) return
      this.pending.delete(guest.id)
      cleanup()
      reply(type === 'alert' ? null : type === 'confirm' ? answer.accept : answer.accept ? String(answer.text ?? dialog.defaultPrompt ?? '').slice(0, MAX_TEXT) : null)
      this.notify(guest.id, host, null)
    }
    const cancel = (): void => settle({ accept: false })
    const onNavigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => { if (mainFrame && !inPlace) cancel() }
    guest.on('did-start-navigation', onNavigation)
    guest.once('destroyed', cancel)
    this.pending.set(guest.id, { id, dialog, reply: settle })
    this.notify(guest.id, host, dialog, id)
  }

  private notify(webContentsId: number, host: WebContents | null, dialog: BrowserDialog | null, id?: string): void {
    for (const listener of this.listeners) listener(webContentsId, dialog)
    const event: BrowserDialogEvent = { webContentsId, dialog: dialog && id ? { ...dialog, id } : null }
    try { if (host && !host.isDestroyed()) host.send(BROWSER_PAGE_CHANNELS.dialog, event) } catch { /* host gone */ }
  }
}

/** Takes the guest preload's dialog calls. Returns an unregister function. */
export function registerGuestDialogs(dialogs: GuestDialogs): () => void {
  const onDialog = (event: IpcMainEvent, request: unknown): void => {
    const guest = event.sender
    const reply = (value: unknown): void => { event.returnValue = value }
    // Only a browser panel's page gets dialogs: a webview a window hosts.
    if (guest.getType() !== 'webview' || event.senderFrame !== guest.mainFrame || !guest.hostWebContents) {
      reply(request && typeof request === 'object' && (request as { type?: unknown }).type === 'confirm' ? false : null)
      return
    }
    dialogs.open(guest, request, reply)
  }
  ipcMain.on(BROWSER_GUEST_CHANNELS.dialog, onDialog)
  return () => { ipcMain.removeListener(BROWSER_GUEST_CHANNELS.dialog, onDialog) }
}
