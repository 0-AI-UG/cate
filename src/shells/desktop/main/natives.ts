// The desktop `ClientUi` natives (kernel/ui): message boxes, file pickers and
// the save dialog, OS file actions, the clipboard and OS notifications. Feature
// dialogs (confirm close terminal, ...) are message boxes the renderer words.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, clipboard, dialog, nativeImage, Notification, shell, type IpcMainInvokeEvent } from 'electron'
import type { FileApp } from '@kernel/ui/contract'
import {
  CANVAS_WALLPAPER_PICKER_EXTENSIONS,
  DESKTOP_CHANNELS as C,
  type MessageBoxRequest,
  type NotificationRequest,
  type OpenDialogRequest,
} from '../contract'
import { appBundleIcon } from './appBundleIcon'
import type { CanvasBackgrounds } from './canvasBackgrounds'
import { handle } from './ipc'
import type { WindowRegistry } from './windowRegistry'

const execFileAsync = promisify(execFile)

/** Paths the OS file actions may touch: files of workspaces whose runtime
 *  runs on this machine (their roots, dialed this session) and `~/.cate`. */
export class LocalFileScope {
  private readonly roots = new Set<string>()

  constructor(extra: string[] = []) {
    for (const root of extra) this.add(root)
  }

  add(root: string): void {
    this.roots.add(path.resolve(root))
  }

  /** The resolved path, or throws when it is not a local workspace file. */
  check(filePath: unknown): string {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Not a file on this device.')
    const resolved = path.resolve(filePath)
    for (const root of this.roots) {
      if (resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return resolved
    }
    throw new Error('This file is not on this device.')
  }
}

export function githubRepositoryUrl(remote: string): string | null {
  const value = remote.trim().replace(/\.git$/, '')
  const ssh = /^git@github\.com:(.+)$/.exec(value)
  if (ssh) return `https://github.com/${ssh[1]}`
  const https = /^https?:\/\/github\.com\/(.+)$/.exec(value)
  return https ? `https://github.com/${https[1]}` : null
}

const FILE_APP_CANDIDATES = ['Cursor', 'Visual Studio Code', 'Xcode', 'Zed', 'Sublime Text', 'Terminal', 'iTerm']

export interface NativesDeps {
  registry: WindowRegistry<BrowserWindow>
  scope: LocalFileScope
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
  const detectedApps = new Map<string, string>()
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

  handle(C.dialogSave, async (event, request: { defaultName?: string; defaultPath?: string; title?: string } = {}) => {
    const win = windowOf(event)
    const options = { title: request.title ?? 'Save File', defaultPath: request.defaultPath || request.defaultName || 'Untitled.txt' }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return result.canceled || !result.filePath ? null : result.filePath
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

  handle(C.osFileApps, async (): Promise<FileApp[]> => {
    if (process.platform !== 'darwin') return []
    const found = await Promise.all(FILE_APP_CANDIDATES.map(async (name) => {
      for (const root of ['/Applications', path.join(os.homedir(), 'Applications'), '/System/Applications/Utilities']) {
        const appPath = path.join(root, `${name}.app`)
        if (!fs.existsSync(appPath)) continue
        detectedApps.set(name, appPath)
        return { id: name, name, icon: await appBundleIcon(appPath) }
      }
      return null
    }))
    return found.filter((entry): entry is FileApp => entry !== null)
  })

  handle(C.osOpenFile, async (_event, filePath: unknown, appId?: unknown) => {
    const safe = deps.scope.check(filePath)
    if (typeof appId === 'string' && appId) {
      const appPath = detectedApps.get(appId)
      if (!appPath || process.platform !== 'darwin') throw new Error('That application is unavailable.')
      const target = appId === 'Terminal' || appId === 'iTerm' ? path.dirname(safe) : safe
      await execFileAsync('/usr/bin/open', ['-a', appPath, '--', target])
      return
    }
    const error = await shell.openPath(safe)
    if (error) throw new Error(error)
  })

  handle(C.osRevealFile, (_event, filePath: unknown) => {
    shell.showItemInFolder(deps.scope.check(filePath))
  })

  handle(C.osOpenFileOnGitHub, async (_event, filePath: unknown) => {
    const safe = deps.scope.check(filePath)
    const cwd = path.dirname(safe)
    let root: string, remote: string, revision: string
    try {
      ;[{ stdout: root }, { stdout: remote }, { stdout: revision }] = await Promise.all([
        execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel']),
        execFileAsync('git', ['-C', cwd, 'remote', 'get-url', 'origin']),
        execFileAsync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']),
      ])
    } catch {
      throw new Error('This file is not in a git repository with an origin remote.')
    }
    const repository = githubRepositoryUrl(remote)
    if (!repository) throw new Error('The origin remote is not on GitHub.')
    const relative = path.relative(root.trim(), safe).split(path.sep).map(encodeURIComponent).join('/')
    await shell.openExternal(`${repository}/blob/${encodeURIComponent(revision.trim() || 'HEAD')}/${relative}`)
  })

  handle(C.osStartFileDrag, (event, filePath: unknown) => {
    const safe = deps.scope.check(filePath)
    const image = nativeImage.createFromPath(safe)
    event.sender.startDrag({ file: safe, icon: image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 64 }) })
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
