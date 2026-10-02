// The desktop `ClientUi` natives (kernel/ui): message boxes, file pickers,
// opening links and the device settings file, the clipboard and OS
// notifications. Feature dialogs (confirm close terminal, ...) are message
// boxes the renderer words.

import { app, BrowserWindow, clipboard, dialog, Notification, shell, type IpcMainInvokeEvent } from 'electron'
import {
  CANVAS_WALLPAPER_PICKER_EXTENSIONS,
  DESKTOP_CHANNELS as C,
  type MessageBoxRequest,
  type NotificationRequest,
  type OpenDialogRequest,
} from '../contract'
import type { CanvasBackgrounds } from './canvasBackgrounds'
import { handle } from './ipc'
import type { WindowRegistry } from './windowRegistry'

export interface NativesDeps {
  registry: WindowRegistry<BrowserWindow>
  /** The device `settings.json`, opened by "Open settings file". */
  settingsFile: string
  backgrounds: CanvasBackgrounds
  focusWindow(win: BrowserWindow): void
}

// Holding each notification until it resolves keeps its click handler alive;
// otherwise it is collected and a click on the banner does nothing (macOS).
const liveNotifications = new Set<Notification>()

function showOsNotification(options: { title: string; body: string; onClick?: () => void }): void {
  if (Notification.isSupported()) {
    const notification = new Notification({ title: options.title, body: options.body })
    liveNotifications.add(notification)
    const release = () => { liveNotifications.delete(notification) }
    notification.on('click', () => { options.onClick?.(); release() })
    notification.on('close', release)
    notification.on('failed', release)
    notification.show()
  }
  if (process.platform === 'darwin') app.dock?.bounce('informational')
}

export function registerNatives(deps: NativesDeps): void {
  const windowOf = (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win && !win.isDestroyed() ? win : undefined
  }
  const messageBox = (event: IpcMainInvokeEvent, options: Electron.MessageBoxOptions) => {
    const win = windowOf(event)
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  }

  handle(C.dialogMessageBox, async (event, request: MessageBoxRequest) => {
    const buttons = Array.isArray(request?.buttons) && request.buttons.length > 0 ? request.buttons.map(String) : ['OK']
    const { response } = await messageBox(event, {
      type: request.type ?? 'none',
      message: String(request.message ?? ''),
      detail: request.detail,
      buttons,
      defaultId: request.defaultId,
      cancelId: request.cancelId ?? buttons.length - 1,
      noLink: true,
    })
    return response
  })

  handle(C.dialogOpen, async (event, request: OpenDialogRequest = {}) => {
    const win = windowOf(event)
    const properties: Electron.OpenDialogOptions['properties'] = request.directory
      ? ['openDirectory', 'createDirectory']
      : ['openFile']
    if (request.multiple) properties.push('multiSelections')
    const options: Electron.OpenDialogOptions = {
      title: request.title,
      defaultPath: request.defaultPath,
      filters: request.filters,
      properties,
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths
  })

  handle(C.canvasBackgroundPick, async (event) => {
    const win = windowOf(event)
    const options: Electron.OpenDialogOptions = {
      title: 'Choose Canvas Background Image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: [...CANVAS_WALLPAPER_PICKER_EXTENSIONS] }],
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return deps.backgrounds.importImage(result.filePaths[0])
  })
  handle(C.canvasBackgroundRead, (_event, filePath: unknown) => deps.backgrounds.read(filePath as string))
  handle(C.canvasBackgroundPrune, (_event, keep: unknown) => deps.backgrounds.prune(typeof keep === 'string' ? keep : ''))

  handle(C.osOpenExternal, async (_event, url: unknown) => {
    if (typeof url !== 'string' || !/^(https?|mailto):/i.test(url)) throw new Error('Only web and mail links open externally.')
    await shell.openExternal(url)
  })

  handle(C.osOpenSettingsFile, async () => {
    const error = await shell.openPath(deps.settingsFile)
    if (error) throw new Error(error)
  })

  handle(C.clipboardWrite, (_event, text: unknown) => { clipboard.writeText(typeof text === 'string' ? text : '') })
  handle(C.clipboardRead, () => clipboard.readText())

  handle(C.notify, (event, request: NotificationRequest) => {
    const win = windowOf(event)
    const contents = event.sender
    showOsNotification({
      title: String(request?.title ?? ''),
      body: String(request?.body ?? ''),
      onClick: () => {
        if (win && !win.isDestroyed()) deps.focusWindow(win)
        if (request?.action !== undefined && !contents.isDestroyed()) contents.send(C.notificationAction, request.action)
      },
    })
  })
}
