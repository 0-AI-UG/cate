// Moving between workspaces: selecting one opens its connection (and asks for
// trust the first time), closing one disconnects. Revealing and closing
// panels are client/host's; this module plugs workspace selection and window
// raising into its reveal hooks.

import { clientHas } from '@client/connections'
import { documentStoreFor } from '@client/document'
import { installRevealHooks, closePanels as closeHostPanels, revealPanel as revealHostPanel } from '@client/host'
import { MAIN_WINDOW, type PanelId } from '@workspace/document/contract'
import { clientUi, errorMessage } from '@kernel/ui'
import { clientApp } from './app'
import { desktopPort } from './desktop'
import { useUIStore } from './state/uiStore'

/** A workspace whose trust question the person declined stays closed. */
export type TrustCheck = (workspaceId: string, label: string) => Promise<boolean>
let trustCheck: TrustCheck | null = null

/** Installed by the shell with `trustStore.ensureTrusted` from workspace/lifecycle. */
export function installTrustCheck(check: TrustCheck | null): void {
  trustCheck = check
}

/** Opens (when needed) and shows a workspace in this window. */
export async function selectWorkspace(workspaceId: string): Promise<boolean> {
  const { workspaces } = clientApp()
  const entry = workspaces.get(workspaceId)
  if (!entry) return false
  const wasOpen = workspaces.getSnapshot().open.includes(workspaceId)
  try {
    if (!wasOpen) await workspaces.open(workspaceId)
  } catch (err) {
    clientUi().showError(errorMessage(err, `Could not open ${entry.name}`))
    return false
  }
  useUIStore.getState().setSelectedWorkspace(workspaceId)
  if (!wasOpen && trustCheck) {
    const label = entry.kind === 'local' ? entry.root : entry.name
    if (!(await trustCheck(workspaceId, label))) {
      closeWorkspace(workspaceId)
      return false
    }
  }
  return true
}

/** Adds a folder on this device to the list and opens it. */
export async function openLocalFolder(root: string): Promise<boolean> {
  const entry = await clientApp().workspaces.addLocal(root)
  return selectWorkspace(entry.id)
}

/** Asks the shell for a folder and opens it. */
export async function pickAndOpenFolder(): Promise<boolean> {
  const root = await desktopPort()?.pickFolder()
  return root ? openLocalFolder(root) : false
}

/** Disconnects this client; the runtime follows `runtimeLifetime`. */
export function closeWorkspace(workspaceId: string): void {
  const { workspaces } = clientApp()
  workspaces.close(workspaceId)
  const ui = useUIStore.getState()
  if (ui.selectedWorkspaceId !== workspaceId) return
  const next = workspaces.getSnapshot().open.find((id) => id !== workspaceId) ?? null
  ui.setSelectedWorkspace(next)
}

/** The next or previous workspace in sidebar order, wrapping. */
export function cycleWorkspace(step: 1 | -1): void {
  const entries = clientApp().workspaces.getSnapshot().entries
  if (entries.length === 0) return
  const current = entries.findIndex((e) => e.id === useUIStore.getState().selectedWorkspaceId)
  const next = entries[(current + step + entries.length) % entries.length]
  if (next) void selectWorkspace(next.id)
}

/** Plugs workspace selection and window raising into client/host's reveal. */
export function installNavigationHooks(): () => void {
  return installRevealHooks({
    async selectWorkspace(workspaceId) {
      if (useUIStore.getState().selectedWorkspaceId !== workspaceId) await selectWorkspace(workspaceId)
    },
    showWindow(workspaceId, windowId) {
      if (windowId !== MAIN_WINDOW) desktopPort()?.focusWindow(workspaceId, windowId)
    },
  })
}

export function revealPanel(workspaceId: string, panelId: PanelId): Promise<boolean> {
  return revealHostPanel(workspaceId, panelId, { retry: true })
}

/** Closes panels after their close guards. */
export function closePanels(workspaceId: string, panelIds: PanelId[]): Promise<boolean> {
  return closeHostPanels(workspaceId, panelIds)
}

export function renamePanel(workspaceId: string, panelId: PanelId, title: string): boolean {
  const store = documentStoreFor(workspaceId)
  if (!store) return false
  return store.propose({ kind: 'updatePanel', id: panelId, patch: { title } }).ok
}

/** Moves a panel into a new detached window (a placement op every client
 *  sees; a client without `windows` shows it as a stack). */
export function detachPanel(workspaceId: string, panelId: PanelId): boolean {
  const store = documentStoreFor(workspaceId)
  if (!store) return false
  const id = () => globalThis.crypto.randomUUID()
  return store.propose({
    kind: 'placePanel',
    id: panelId,
    at: { to: 'window', windowId: id(), stackId: id(), bounds: { origin: { x: 120, y: 120 }, size: { width: 900, height: 640 } } },
  }).ok
}

/** "Move into new window" is offered only where windows exist. */
export function canDetachPanels(): boolean {
  return clientHas('windows')
}

/** Opens a workspace file in a panel (reusing one that shows it). Installed
 *  by the module that owns file routing; without it the palette lists no files. */
export type FileOpener = (workspaceId: string, path: string) => Promise<void> | void
let fileOpener: FileOpener | null = null

export function installFileOpener(opener: FileOpener | null): void {
  fileOpener = opener
}

export function canOpenFiles(): boolean {
  return fileOpener !== null
}

export async function openWorkspaceFile(workspaceId: string, path: string): Promise<void> {
  await fileOpener?.(workspaceId, path)
}
