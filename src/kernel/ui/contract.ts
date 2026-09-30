// kernel/ui contract: theme schema and data, shortcut catalog, icon names and
// the ClientUi port type. Pure; the settings slice and the desktop shell's
// theme boot cache import it.

export * from './contract/theme'
export * from './contract/themes'
export * from './contract/themeResolution'
export * from './contract/uiScale'
export * from './contract/colors'
export * from './contract/shortcuts'
export * from './contract/icons'

export type NotificationAction =
  | { type: 'focusTerminal'; workspaceId: string; terminalId: string }
  | { type: 'focusPanel'; workspaceId: string; panelId: string }

export interface ClientNotification {
  title: string
  body: string
  action?: NotificationAction
}

/** One entry of a context menu; a separator has only `type`. */
export interface ContextMenuItem {
  id?: string
  label?: string
  accelerator?: string
  enabled?: boolean
  type?: 'normal' | 'separator'
  submenu?: ContextMenuItem[]
}

export interface FileApp {
  id: string
  name: string
  icon: string
}

/** OS file actions, installed by a shell that declares `osFiles`. Workspace
 *  files outside Cate, as far as the device allows: list the apps that can
 *  open files, open one (in `appId`, else the default app), reveal it in the
 *  OS file browser, or open it on its GitHub remote. open* reject with a
 *  message the caller can show. */
export interface ClientUiOsFiles {
  saveFileDialog(options: { defaultName?: string; defaultPath?: string }): Promise<string | null>
  fileApps(): Promise<FileApp[]>
  openFile(path: string, workspaceId?: string, appId?: string): Promise<void>
  revealFile(path: string, workspaceId?: string): Promise<void>
  openFileOnGitHub(path: string, workspaceId?: string): Promise<void>
}

/** Installed by a shell that declares `clipboard`. */
export interface ClientUiClipboard {
  writeClipboard(text: string): Promise<void>
}

/** Installed by a shell that declares `osNotifications`. Settings- and
 *  focus-gated by the client. Without it the client shows an in-app toast. */
export interface ClientUiOsNotifications {
  notify(notification: ClientNotification): void
}

/**
 * Everything a view may ask of the person using this client. Each shell
 * installs its own implementation (`installClientUi`); sessions and runtime
 * code never call it. Methods tied to a client feature are optional: a shell
 * installs only what it declares, and callers handle their absence.
 *
 * Feature modules add their own dialogs by augmenting this interface:
 *
 *   declare module '@kernel/ui/contract' {
 *     interface ClientUi {
 *       confirmCloseTerminal(request: {...}): Promise<'close' | 'cancel'>
 *     }
 *   }
 */
export interface ClientUi extends Partial<ClientUiOsFiles>, Partial<ClientUiClipboard>, Partial<ClientUiOsNotifications> {
  openExternal(url: string): void
  openSettings(section: string): void
  /** A yes/no question before a destructive action. */
  confirm(message: string): Promise<boolean>
  /** A failed user action the person should see. */
  showError(message: string): void
  /** A context menu at the pointer. Resolves with the picked id, or null when
   *  dismissed. Optional: without it views offer their toolbar and keyboard
   *  actions only. */
  showContextMenu?(items: ContextMenuItem[]): Promise<string | null>
  confirmUnsavedChanges(request: { fileName?: string; multiple?: boolean; filePath?: string }): Promise<'save' | 'discard' | 'cancel'>
}
