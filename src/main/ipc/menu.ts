// =============================================================================
// Native context menu IPC — renderer sends a serializable template, main
// process pops up a native Electron Menu and resolves with the clicked item id.
// =============================================================================

import { BrowserWindow, Menu, ipcMain, type MenuItemConstructorOptions } from 'electron'
import { MENU_SHOW_CONTEXT } from '../../shared/ipc-channels'

export interface ContextMenuTemplateItem {
  id?: string
  label?: string
  accelerator?: string
  enabled?: boolean
  type?: 'normal' | 'separator'
  submenu?: ContextMenuTemplateItem[]
}

function buildTemplate(
  items: ContextMenuTemplateItem[],
  onClick: (id: string) => void,
): MenuItemConstructorOptions[] {
  return items.map((item) => {
    if (item.type === 'separator') return { type: 'separator' }
    const opt: MenuItemConstructorOptions = {
      label: item.label ?? '',
      enabled: item.enabled !== false,
    }
    if (item.accelerator) opt.accelerator = item.accelerator
    if (item.submenu && item.submenu.length > 0) {
      opt.submenu = buildTemplate(item.submenu, onClick)
    } else if (item.id) {
      const id = item.id
      opt.click = () => onClick(id)
    }
    return opt
  })
}

export function registerHandlers(): void {
  ipcMain.handle(
    MENU_SHOW_CONTEXT,
    (event, items: ContextMenuTemplateItem[]) => {
      return new Promise<string | null>((resolve) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) {
          resolve(null)
          return
        }
        let chosen: string | null = null
        const menu = Menu.buildFromTemplate(
          buildTemplate(items, (id) => {
            chosen = id
          }),
        )
        menu.popup({
          window: win,
          callback: () => resolve(chosen),
        })
      })
    },
  )
}
