// The desktop ClientUi: native message boxes and OS actions over the desktop
// IPC, settings through this window's overlay, and the portable in-app save
// dialog. Methods tied to a feature are installed only when the
// window declares it (12.2 rule 5).

import type { ClientFeature } from '@kernel/rpc/contract'
import type { ClientUi } from '@kernel/interaction/contract'
import { useUIStore } from '../ui/app'
import { showSavePathDialog } from '../ui/workspace/files'
import type { DesktopApi, MessageBoxRequest } from '../contract'

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export function createDesktopClientUi(api: DesktopApi, features: readonly ClientFeature[]): ClientUi {
  const has = (feature: ClientFeature) => features.includes(feature)
  const ask = (request: MessageBoxRequest) => api.dialogs.messageBox(request)

  const ui: ClientUi = {
    openExternal: (url) => { void api.os.openExternal(url).catch(() => { /* refused: not a web link */ }) },
    openSettings: (section) => useUIStore.getState().openSettings(section || undefined),
    async confirm(message) {
      return (await ask({ type: 'question', message, buttons: ['OK', 'Cancel'], defaultId: 0, cancelId: 1 })) === 0
    },
    showError(message) {
      void ask({ type: 'error', message, buttons: ['OK'] })
    },
    showContextMenu: (items) => api.menu.showContextMenu(items),
    async confirmUnsavedChanges({ fileName, multiple, filePath }) {
      const lost = "Your changes will be lost if you don't save them."
      const detail = multiple
        ? lost
        : filePath
          ? `${filePath}\n\n${lost}`
          : `This file has not been saved yet. Save will prompt for a location.\n\n${lost}`
      const response = await ask({
        type: 'warning',
        message: `Do you want to save the changes you made to ${fileName ?? (multiple ? 'these files' : 'this file')}?`,
        detail,
        buttons: ['Save', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
      })
      return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel'
    },
    async confirmCloseTerminal({ count, processName }) {
      const name = processName?.trim()
      const message = count > 1
        ? `Close ${count} terminals that are still running?`
        : name ? `“${name}” is still running. Close this terminal?` : 'This terminal is still running. Close it?'
      const response = await ask({
        type: 'warning',
        message,
        detail: count > 1
          ? 'The processes running in these terminals will be terminated.'
          : 'The process running in this terminal will be terminated.',
        buttons: ['Close', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      })
      return response === 0 ? 'close' : 'cancel'
    },
    async promptLinkOpen(url) {
      const response = await ask({
        type: 'question',
        message: 'Open link',
        detail: `${url}\n\nYou can change this later in Settings → Browser.`,
        buttons: ['On Canvas', 'In System Browser', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
      })
      return response === 0 ? 'canvas' : response === 1 ? 'external' : 'cancel'
    },
    async confirmCloseCanvas({ panelCount, canMove }) {
      const panels = plural(panelCount, 'open panel', 'open panels')
      if (!canMove) {
        const response = await ask({
          type: 'warning',
          message: 'Close this canvas?',
          detail: panelCount > 0 ? `Closing it will also close its ${panels}.` : 'This canvas has no open panels.',
          buttons: ['Close', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        })
        return response === 0 ? 'close' : 'cancel'
      }
      const response = await ask({
        type: 'warning',
        message: 'Close this canvas?',
        detail: `This canvas contains ${panels}. What would you like to do with them?`,
        buttons: ['Move to Another Canvas', 'Delete All Panels', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
      })
      return response === 0 ? 'move' : response === 1 ? 'delete' : 'cancel'
    },
    pickSavePath: showSavePathDialog,
    async confirmImportEntries({ count, destName }) {
      const response = await ask({
        type: 'question',
        message: `Copy ${plural(count, 'item', 'items')} into "${destName}"?`,
        detail: 'The originals stay where they are.',
        buttons: ['Copy', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      })
      return response === 0 ? 'copy' : 'cancel'
    },
  }

  if (has('clipboard')) {
    ui.writeClipboard = (text) => api.os.writeClipboard(text)
    ui.readClipboard = () => api.os.readClipboard()
  }
  if (has('osNotifications')) {
    ui.notify = ({ title, body, action }) => { void api.os.notify({ title, body, action }) }
  }
  return ui
}
