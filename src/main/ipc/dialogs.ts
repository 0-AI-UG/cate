import { ipcMain, dialog, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import log from '../logger'
import { wrapHandler } from './handlerError'
import { validatePath, grantFileAccess } from './pathValidation'
import { isLocalLocator } from '../runtime/locator'
import { forwardFileGrant } from '../runtime/runtimeManager'
import { recordPersistentGrant } from '../grantedPathStore'
import { importCanvasBackgroundImage } from '../canvasBackgroundStore'
import { listWindows, windowFromEvent } from '../windowRegistry'
import {
  SHELL_SHOW_IN_FOLDER,
  DIALOG_OPEN_FOLDER,
  DIALOG_OPEN_IMAGE,
  DIALOG_SAVE_FILE,
  DIALOG_CONFIRM_UNSAVED,
  DIALOG_CONFIRM_CLOSE_TERMINAL,
  DIALOG_CONFIRM_CLOSE_CANVAS,
  DIALOG_CONFIRM_IMPORT,
  DIALOG_CONFIRM_RELOAD_WORKSPACE,
  DIALOG_CONFIRM_DISCARD_JOB,
  DIALOG_TERMINAL_LINK_OPEN,
  CANVAS_READ_BACKGROUND_IMAGE,
} from '../../shared/ipc-channels'

export function registerDialogHandlers(): void {
  // Shell: Reveal in Finder
  ipcMain.handle(SHELL_SHOW_IN_FOLDER, wrapHandler('[SHELL_SHOW_IN_FOLDER]', async (event, filePath: string, workspaceId?: string) => {
    // A remote (cate-runtime://) path has no representation on this machine —
    // there is nothing local to reveal. Return a structured result instead of
    // throwing so the renderer can quietly ignore/disable the action.
    if (!isLocalLocator(filePath)) {
      return { ok: false, reason: 'remote' }
    }
    const win = windowFromEvent(event)
    shell.showItemInFolder(validatePath(filePath, win?.id, workspaceId))
    return { ok: true }
  }))

  // Dialog handlers
  ipcMain.handle(DIALOG_OPEN_FOLDER, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Project Folder',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Pick an image to use as the canvas wallpaper. The picked file is COPIED into
  // managed app data (see ./canvasBackgroundStore) and the managed path is
  // returned for storage in settings — so the wallpaper survives the source
  // file moving/being deleted and stays self-contained. The renderer reads the
  // bytes via CANVAS_READ_BACKGROUND_IMAGE; no path grant is needed because that
  // reader runs in main (full fs access) rather than through the sandboxed fs IPC.
  ipcMain.handle(DIALOG_OPEN_IMAGE, async (event) => {
    const win = windowFromEvent(event)
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose Canvas Background Image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return importCanvasBackgroundImage(result.filePaths[0])
  })

  // Read a canvas-wallpaper image as a data URL. Used both right after the user
  // picks one and on every launch to restore the saved path. Guarded by
  // extension + size so a hand-edited settings.json can't turn this into an
  // arbitrary file-to-data-URL exfiltration primitive.
  ipcMain.handle(CANVAS_READ_BACKGROUND_IMAGE, async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath === '') return null
    const MIME_BY_EXT: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.avif': 'image/avif',
    }
    const ext = path.extname(filePath).toLowerCase()
    const mime = MIME_BY_EXT[ext]
    if (!mime) return null
    try {
      const stat = await fs.promises.stat(filePath)
      const MAX_BYTES = 40 * 1024 * 1024 // 40 MB ceiling — keeps a data URL sane.
      if (!stat.isFile() || stat.size > MAX_BYTES) return null
      const buf = await fs.promises.readFile(filePath)
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch (err) {
      log.warn('[CANVAS_READ_BACKGROUND_IMAGE] Failed to read %s: %O', filePath, err)
      return null
    }
  })

  // Native Save-As dialog for untitled editor buffers.
  ipcMain.handle(DIALOG_SAVE_FILE, async (event, payload: { defaultName?: string; defaultPath?: string }) => {
    const win = windowFromEvent(event)
    const result = await dialog.showSaveDialog(win!, {
      title: 'Save File',
      defaultPath: payload?.defaultPath || payload?.defaultName || 'Untitled.txt',
    })
    if (result.canceled || !result.filePath) return null
    // The picked location is almost always outside the workspace allowed
    // roots (Desktop, Documents, …). Grant the calling window persistent
    // read+write access to the exact file so the initial fsWriteFile AND
    // every subsequent reload / Cmd+S on this editor succeed for the
    // lifetime of the window. The grant is dropped on window close.
    // Return the canonical safe path (realpath-of-parent + basename) so the
    // renderer stores the same string the grant set keys on — otherwise a
    // symlinked parent would yield a stored alias that later fails the
    // lexical validatePath check before realpath has a chance to run.
    if (win) {
      try {
        const safePath = await grantFileAccess(win.id, result.filePath)
        // Mirror the grant into the owning runtime (the LOCAL daemon owns this
        // host-absolute path) so the initial write + later reloads validate there.
        forwardFileGrant(safePath, win.id)
        // Persist the approval so future windows (and future app launches)
        // can read+write this file via createWindow's grantsReady pass.
        // Critically there is NO renderer-facing IPC to add paths here —
        // only paths the user just confirmed in a native dialog land in
        // the store.
        try {
          await recordPersistentGrant(safePath)
        } catch (err) {
          log.warn('[DIALOG_SAVE_FILE] Failed to persist grant:', err)
        }
        // Grant the path to every currently-open window too. Without this,
        // a panel transferred to a window that existed BEFORE the Save-As
        // would lose access (createWindow's grantsReady only runs at the
        // owning window's creation — older sibling windows never see the
        // newly approved path otherwise).
        for (const other of listWindows()) {
          if (other.id === win.id) continue
          try {
            await grantFileAccess(other.id, safePath)
            forwardFileGrant(safePath, other.id)
          } catch (err) {
            log.warn('[DIALOG_SAVE_FILE] Failed to grant to window %d: %s', other.id, err)
          }
        }
        return safePath
      } catch (err) {
        log.warn('[DIALOG_SAVE_FILE] Failed to grant file access:', err)
      }
    }
    return result.filePath
  })

  // Native unsaved-changes confirmation. Returns 'save' | 'discard' | 'cancel'.
  ipcMain.handle(
    DIALOG_CONFIRM_UNSAVED,
    async (event, payload: { fileName?: string; multiple?: boolean; filePath?: string }) => {
      const win = windowFromEvent(event)
      const name = payload?.fileName ?? 'this file'
      const message = payload?.multiple
        ? `Do you want to save the changes you made to ${payload?.fileName ?? 'these files'}?`
        : `Do you want to save the changes you made to ${name}?`
      // For a single dirty file, show the on-disk location so the user knows
      // exactly which file the "Save" button is going to overwrite. Untitled
      // buffers (no filePath) fall back to a hint that a Save-As picker will
      // appear after confirming.
      const baseDetail = "Your changes will be lost if you don't save them."
      const detail = payload?.multiple
        ? baseDetail
        : payload?.filePath
          ? `${payload.filePath}\n\n${baseDetail}`
          : `This file has not been saved yet. Save will prompt for a location.\n\n${baseDetail}`
      const result = await dialog.showMessageBox(win!, {
        type: 'warning',
        message,
        detail,
        buttons: ['Save', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      return result.response === 0 ? 'save' : result.response === 1 ? 'discard' : 'cancel'
    },
  )

  // Confirm closing a terminal that's running a foreground process (dev server,
  // editor, agent, …). Returns 'close' | 'cancel'.
  ipcMain.handle(
    DIALOG_CONFIRM_CLOSE_TERMINAL,
    async (event, payload: { count?: number; processName?: string | null }) => {
      const win = windowFromEvent(event)
      const count = payload?.count ?? 1
      const name = payload?.processName?.trim()
      const message =
        count > 1
          ? `Close ${count} terminals that are still running?`
          : name
            ? `“${name}” is still running. Close this terminal?`
            : 'This terminal is still running. Close it?'
      const detail =
        count > 1
          ? 'The processes running in these terminals will be terminated.'
          : 'The process running in this terminal will be terminated.'
      const result = await dialog.showMessageBox(win!, {
        type: 'warning',
        message,
        detail,
        buttons: ['Close', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      return result.response === 0 ? 'close' : 'cancel'
    },
  )

  // Confirm close of a canvas panel. When the workspace has other canvases and
  // the closing canvas contains panels, the user is offered three choices:
  // move the panels to another canvas, delete them, or cancel. When it's the
  // last canvas (or empty) a simple close/cancel prompt is shown.
  ipcMain.handle(DIALOG_CONFIRM_CLOSE_CANVAS, async (event, payload: { panelCount: number; isLast: boolean }) => {
    const win = windowFromEvent(event)
    const { panelCount, isLast } = payload ?? { panelCount: 0, isLast: true }

    // Simple close prompt: last canvas, or an empty canvas on a multi-canvas workspace.
    if (isLast || panelCount === 0) {
      const result = await dialog.showMessageBox(win!, {
        type: 'warning',
        message: 'Close this canvas?',
        detail: panelCount > 0
          ? `Closing it will also close its ${panelCount} open ${panelCount === 1 ? 'panel' : 'panels'}.`
          : isLast
            ? 'This is the only canvas in the workspace.'
            : 'This canvas has no open panels.',
        buttons: ['Close', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      return result.response === 0 ? 'close' : 'cancel'
    }

    // Multi-canvas workspace with contained panels: offer move / delete / cancel.
    const result = await dialog.showMessageBox(win!, {
      type: 'warning',
      message: 'Close this canvas?',
      detail: `This canvas contains ${panelCount} open ${panelCount === 1 ? 'panel' : 'panels'}. What would you like to do with them?`,
      buttons: ['Move to Another Canvas', 'Delete All Panels', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    return result.response === 0 ? 'move' : result.response === 1 ? 'delete' : 'cancel'
  })

  // Ask whether to copy or move external files/folders dropped onto the file
  // explorer into a workspace directory.
  ipcMain.handle(DIALOG_CONFIRM_IMPORT, async (event, payload: { count: number; destName: string }) => {
    const win = windowFromEvent(event)
    const count = payload?.count ?? 0
    const destName = payload?.destName ?? 'this folder'
    const result = await dialog.showMessageBox(win!, {
      type: 'question',
      message: `Add ${count} ${count === 1 ? 'item' : 'items'} to "${destName}"?`,
      detail: 'Copy keeps the originals where they are. Move removes them from their current location.',
      buttons: ['Copy', 'Move', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    return result.response === 0 ? 'copy' : result.response === 1 ? 'move' : 'cancel'
  })

  // Confirm reloading the canvas after the workspace.json file changed on disk
  // (edited externally while Cate was running).
  ipcMain.handle(DIALOG_CONFIRM_RELOAD_WORKSPACE, async (event, payload: { name?: string }) => {
    const win = windowFromEvent(event)
    const name = payload?.name?.trim()
    const result = await dialog.showMessageBox(win!, {
      type: 'question',
      message: 'Reload workspace from disk?',
      detail: `The workspace file${name ? ` for "${name}"` : ''} changed on disk. Reload to apply it? This rebuilds the canvas and restarts terminals; the current in-app layout will be discarded.`,
      buttons: ['Reload', 'Keep Current'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0 ? 'reload' : 'cancel'
  })

  // Confirm discarding an agent job. Discarding tears down the job's worktree
  // and closes any terminals it opened, so the detail spells out the
  // consequences based on what the job actually has. Returns 'discard' | 'cancel'.
  ipcMain.handle(DIALOG_CONFIRM_DISCARD_JOB, async (event, payload: { hasWorktree?: boolean; terminalCount?: number }) => {
    const win = windowFromEvent(event)
    const hasWorktree = payload?.hasWorktree ?? false
    const terminalCount = payload?.terminalCount ?? 0
    const detail = hasWorktree || terminalCount > 0
      ? `This deletes its worktree${terminalCount > 0 ? ' and closes its terminals' : ''}.`
      : 'This removes the job.'
    const result = await dialog.showMessageBox(win!, {
      type: 'warning',
      message: 'Discard this job?',
      detail,
      buttons: ['Discard', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0 ? 'discard' : 'cancel'
  })

  // Ask where to open a Cmd/Ctrl+clicked terminal link the first time (while the
  // terminalLinkOpenTarget setting is 'ask'). The chosen target is remembered by
  // the renderer and can be changed later in Settings → Browser.
  ipcMain.handle(DIALOG_TERMINAL_LINK_OPEN, async (event, payload: { url: string }) => {
    const win = windowFromEvent(event)
    const url = payload?.url ?? ''
    const result = await dialog.showMessageBox(win!, {
      type: 'question',
      message: 'Open link',
      detail: `${url}\n\nYou can change this later in Settings → Browser.`,
      buttons: ['On Canvas', 'In System Browser', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    return result.response === 0 ? 'canvas' : result.response === 1 ? 'external' : 'cancel'
  })
}
