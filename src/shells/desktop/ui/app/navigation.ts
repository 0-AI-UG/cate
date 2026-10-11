// Moving between workspaces: selecting one opens its connection (and asks for
// trust the first time), closing one disconnects. Revealing and closing
// panels are client/host's; this module plugs workspace selection and window
// raising into its reveal hooks.

import { byMachine, openTrusted, reconcileWindow, selectionAfter } from '@client/workspaces'
import { documentStoreFor } from '@client/document'
import { createPanel, installRevealHooks, panelTypeOpening, closePanels as closeHostPanels, revealPanel as revealHostPanel } from '@client/host'
import { MAIN_WINDOW, renamePanelChange, type PanelId } from '@workspace/document/contract'
import { isLoopbackUrl } from '@runtime/tunnel/contract'
import { isPairingLink } from '@runtime/pairing/contract'
import { clientUi, errorMessage } from '@kernel/interaction'
import { openWindowAt } from '../client/layout/windows'
import { clientApp, tryClientApp } from './app'
import { desktopPort } from './desktop'
import { useUIStore } from './state/uiStore'
import { openFile } from './workspace/fileActions'

/** Opens (when needed) and shows a workspace in this window. */
export async function selectWorkspace(workspaceId: string): Promise<boolean> {
  const { workspaces } = clientApp()
  const entry = workspaces.get(workspaceId)
  if (!entry) return false
  let opened: { trusted: Promise<boolean> }
  try {
    opened = await openTrusted({ workspaces, connections: clientApp().connections, close: closeWorkspace }, workspaceId)
  } catch (err) {
    clientUi().showError(errorMessage(err, `Could not open ${entry.name}`))
    return false
  }
  useUIStore.getState().setSelectedWorkspace(workspaceId)
  return opened.trusted
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
  const { open, entries } = workspaces.getSnapshot()
  ui.setSelectedWorkspace(selectionAfter(workspaceId, open, entries))
}

/** Reconnects open workspaces: their documents and sessions load again
 *  from the runtime. The shown one stays shown. */
export async function reconnectWorkspaces(ids: readonly string[]): Promise<void> {
  const { workspaces } = clientApp()
  const shown = useUIStore.getState().selectedWorkspaceId
  for (const id of ids) workspaces.close(id)
  await Promise.all(ids.map((id) => (id === shown ? selectWorkspace(id) : workspaces.open(id).then(() => {}))))
}

/** The next or previous workspace in sidebar order (machine by machine),
 *  wrapping. */
export function cycleWorkspace(step: 1 | -1): void {
  const entries = byMachine(clientApp().workspaces.getSnapshot().entries)
  if (entries.length === 0) return
  const current = entries.findIndex((e) => e.id === useUIStore.getState().selectedWorkspaceId)
  const next = entries[(current + step + entries.length) % entries.length]
  if (next) void selectWorkspace(next.id)
}

/** Keeps the window's state to what `windowContent` can show, on every
 *  change of the list (`reconcileWindow`): the selection and the Share
 *  dialog only ever name listed workspaces, so everything that reads them
 *  (views, actions, the sidebar) agrees. */
function reconcileWithList(): () => void {
  const workspaces = tryClientApp()?.workspaces
  if (!workspaces) return () => {}
  const reconcile = () => {
    const ui = useUIStore.getState()
    const state = { selected: ui.selectedWorkspaceId, share: ui.shareWorkspaceId }
    const next = reconcileWindow(state, workspaces.getSnapshot())
    if (next === state) return
    if (next.selected !== state.selected) ui.setSelectedWorkspace(next.selected)
    if (next.share !== state.share) ui.openShare(next.share)
  }
  reconcile()
  return workspaces.subscribe(reconcile)
}

/** Plugs workspace selection and window raising into client/host's reveal,
 *  and keeps the shown workspace one of the list. */
export function installNavigationHooks(): () => void {
  const stopFollowing = reconcileWithList()
  const stopReveal = installRevealHooks({
    async selectWorkspace(workspaceId) {
      if (useUIStore.getState().selectedWorkspaceId !== workspaceId) await selectWorkspace(workspaceId)
    },
    showWindow(workspaceId, windowId) {
      if (windowId !== MAIN_WINDOW) desktopPort()?.focusWindow(workspaceId, windowId)
    },
  })
  return () => { stopFollowing(); stopReveal() }
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
  return store.propose(renamePanelChange(panelId, title)).ok
}

/** Moves a panel into a new detached window (a placement op every client
 *  sees; a client without `windows` shows it as a stack). Its position is
 *  this device's. */
export function detachPanel(workspaceId: string, panelId: PanelId): boolean {
  const store = documentStoreFor(workspaceId)
  if (!store) return false
  const id = () => globalThis.crypto.randomUUID()
  const windowId = id()
  openWindowAt(workspaceId, windowId, { origin: { x: 120, y: 120 }, size: { width: 900, height: 640 } })
  return store.propose({ kind: 'placePanel', id: panelId, at: { to: 'window', windowId, stackId: id() } }).ok
}

/** Files open where a panel type opens them; without one the palette lists
 *  no files. */
export function canOpenFiles(): boolean {
  return panelTypeOpening('file') !== null
}

/** Opens a workspace file in a panel (reusing one that shows it). */
export async function openWorkspaceFile(workspaceId: string, path: string): Promise<void> {
  openFile(workspaceId, path)
}

/** A URL opened with the app: a `cate://pair` link fills in "Join with a
 *  Code" (joining stays the person's click); a web URL opens in a panel of
 *  the shown workspace that opens URLs, else outside the app. */
export function openUrl(url: string): void {
  if (isPairingLink(url)) {
    useUIStore.getState().openJoinDialog({ code: url })
    return
  }
  const workspaceId = useUIStore.getState().selectedWorkspaceId
  const type = panelTypeOpening('url')
  if (/^https?:/i.test(url) && workspaceId && type && createPanel(workspaceId, type, { url })) return
  // A loopback URL means a runtime's machine: without a workspace to open it
  // in, it goes nowhere rather than to this device's browser (D10).
  if (!isLoopbackUrl(url)) clientUi().openExternal(url)
}
