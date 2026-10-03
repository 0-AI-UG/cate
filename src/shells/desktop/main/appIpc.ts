// IPC for windows, menus, the updater, analytics, drags, the WebGL budget,
// quit blockers, open requests and perf: the desktop surface that is not
// device files, natives or transports.

import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { ContextMenuItem } from '@kernel/interaction/contract'
import {
  DESKTOP_CHANNELS as C,
  type AppPerfSnapshot,
  type Bounds,
  type DesktopAppInfo,
  type DetachedWindowRef,
  type DragPayload,
  type MenuModel,
  type NativeAction,
} from '../contract'
import type { Analytics } from './analytics/analytics'
import { createCrossWindowDrag } from './crossWindowDrag'
import { createDragGhost } from './dragGhost'
import { revealWindow } from './env'
import { handle, listen } from './ipc'
import { showContextMenu, type AppMenu } from './menu'
import type { OpenRequests } from './openRequests'
import type { AutoUpdater } from './updater/autoUpdater'
import { createWebglBudget } from './webglBudget'
import type { WindowFactory } from './windowFactory'
import type { WindowRegistry } from './windowRegistry'

export interface AppIpcDeps {
  registry: WindowRegistry<BrowserWindow>
  factory: WindowFactory
  menu: AppMenu
  updater: AutoUpdater
  analytics: Analytics
  openRequests: OpenRequests
  appInfo(): Omit<DesktopAppInfo, 'window'>
  perf(): AppPerfSnapshot | null
  focusWindow(win: BrowserWindow): void
}

function detachedRef(value: unknown): DetachedWindowRef {
  const ref = value as Partial<DetachedWindowRef> | null
  if (!ref || typeof ref.workspaceId !== 'string' || typeof ref.windowId !== 'string' || !ref.workspaceId || !ref.windowId) {
    throw new Error('invalid window reference')
  }
  return { workspaceId: ref.workspaceId, windowId: ref.windowId }
}

function validBounds(value: unknown): Bounds | undefined {
  const b = value as Partial<Bounds> | undefined
  if (!b || ![b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  return { x: b.x!, y: b.y!, width: Math.max(1, b.width!), height: Math.max(1, b.height!) }
}

/** Per-renderer state that must go when the renderer does. */
function onRendererGone(contents: WebContents, seen: WeakSet<WebContents>, cleanup: (id: number) => void): void {
  if (seen.has(contents)) return
  seen.add(contents)
  const id = contents.id
  contents.once('destroyed', () => cleanup(id))
  contents.on('render-process-gone', () => cleanup(id))
}

export function registerAppIpc(deps: AppIpcDeps): { blockers(): string[] } {
  const { registry, factory } = deps
  const windowOf = (event: IpcMainInvokeEvent | Electron.IpcMainEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win && !win.isDestroyed() ? win : undefined
  }
  const anyFullscreen = () => registry.list().some((entry) => { try { return entry.win.isFullScreen() } catch { return false } })

  handle(C.appInfo, (event): DesktopAppInfo => {
    const entry = registry.forContents(event.sender.id)
    return {
      ...deps.appInfo(),
      window: { kind: entry?.kind ?? 'main', ...(entry?.ref ?? {}) },
    }
  })

  // Windows of document windows, opened and closed by the renderer's windows port.
  handle(C.windowsOpen, (_event, request: DetachedWindowRef & { bounds?: Bounds }) => {
    factory.openDetached(detachedRef(request), validBounds(request?.bounds))
  })
  handle(C.windowsClose, (_event, ref: unknown) => { factory.closeDetached(detachedRef(ref)) })
  handle(C.windowsFocus, (_event, ref: unknown) => {
    const entry = registry.findDetached(detachedRef(ref))
    if (entry) deps.focusWindow(entry.win)
  })
  handle(C.windowsList, () => registry.detachedRefs())

  // The calling window.
  handle(C.windowNewMain, () => { revealWindow(factory.createMainWindow()) })
  handle(C.windowMinimize, (event) => { windowOf(event)?.minimize() })
  handle(C.windowToggleMaximize, (event) => {
    const win = windowOf(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  handle(C.windowClose, (event) => { windowOf(event)?.close() })
  handle(C.windowSetTitle, (event, title: unknown) => {
    if (typeof title === 'string' && title) windowOf(event)?.setTitle(title)
  })
  handle(C.windowState, (event) => {
    const win = windowOf(event)
    return { fullscreen: win?.isFullScreen() ?? false, maximized: win?.isMaximized() ?? false, focused: win?.isFocused() ?? false }
  })
  // Synchronous: the renderer asks on drag moves whether a drag may leave.
  ipcMain.on(C.anyFullscreen, (event) => { event.returnValue = anyFullscreen() })

  handle(C.menuContext, (event, items: ContextMenuItem[]) => {
    const win = windowOf(event)
    return win ? showContextMenu(win, items) : null
  })
  handle(C.menuBarItems, () => deps.menu.barLabels())
  handle(C.menuPopupBarItem, (event, index: number, x: number, y: number) => {
    const win = windowOf(event)
    if (win) deps.menu.popupBarItem(Number(index), win, Math.round(Number(x)), Math.round(Number(y)))
  })
  handle(C.menuNativeAction, (event, action: NativeAction) => {
    const win = windowOf(event)
    if (win) deps.menu.runNativeAction(win, action)
  })
  handle(C.menuSetModel, (event, model: MenuModel) => {
    if (windowOf(event) && model && Array.isArray(model.bar)) deps.menu.setModel(model)
  })

  handle(C.updateGetStatus, () => deps.updater.status())
  handle(C.updateCheck, () => deps.updater.checkManually())
  handle(C.updateInstall, () => deps.updater.installNow())

  listen(C.analyticsTrack, (_event, feature: unknown, props: unknown) => deps.analytics.trackUsage(feature, props))
  handle(C.analyticsFeedbackPending, () => deps.analytics.feedbackPending())
  handle(C.analyticsFeedbackSubmit, (_event, feedback: unknown) => deps.analytics.submitFeedback(feedback))
  listen(C.analyticsFeedbackDismiss, () => deps.analytics.dismissFeedback())

  const drag = createCrossWindowDrag({
    cursor: () => screen.getCursorScreenPoint(),
    windows: () => registry.list().map((entry) => ({ contentsId: entry.win.webContents.id, bounds: entry.win.getBounds() })),
    ghost: createDragGhost(),
    broadcast: (kind, payload, exceptContents) =>
      registry.broadcast(kind === 'pointer' ? C.dragPointer : C.dragEnded, [payload], { exceptContents }),
    anyFullscreen,
    newId: () => randomUUID(),
  })
  handle(C.dragStart, (event, payload: DragPayload) => {
    if (!payload || typeof payload.workspaceId !== 'string' || typeof payload.panelId !== 'string') return null
    return drag.start(event.sender.id, payload)
  })
  handle(C.dragClaim, (event, dragId: unknown) => drag.claim(event.sender.id, String(dragId)))
  handle(C.dragEnd, (event, dragId: unknown) => drag.end(event.sender.id, String(dragId)))
  handle(C.dragCancel, (_event, dragId: unknown) => drag.cancel(String(dragId)))

  const webgl = createWebglBudget()
  const webglOwners = new WeakSet<WebContents>()
  handle(C.webglRequest, (event, panelId: unknown) => {
    onRendererGone(event.sender, webglOwners, (id) => webgl.reclaim(id))
    return typeof panelId === 'string' && webgl.request(event.sender.id, panelId)
  })
  listen(C.webglRelease, (event, panelId: unknown) => {
    if (typeof panelId === 'string') webgl.release(event.sender.id, panelId)
  })

  const blockers = new Map<number, string[]>()
  const blockerOwners = new WeakSet<WebContents>()
  listen(C.quitBlockers, (event, labels: unknown) => {
    onRendererGone(event.sender, blockerOwners, (id) => blockers.delete(id))
    const list = Array.isArray(labels) ? labels.filter((l): l is string => typeof l === 'string' && !!l).slice(0, 20) : []
    if (list.length > 0) blockers.set(event.sender.id, list)
    else blockers.delete(event.sender.id)
  })

  listen(C.openRequestsReady, (event) => {
    const entry = registry.forContents(event.sender.id)
    if (entry?.kind === 'main') deps.openRequests.markReady(event.sender)
  })

  handle(C.perfGet, () => deps.perf())

  return { blockers: () => [...blockers.values()].flat() }
}
