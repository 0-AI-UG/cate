import { randomUUID } from 'node:crypto'
import { PANEL_TRANSFER_STAGE, PANEL_TRANSFER_READY, PANEL_TRANSFER_COMMIT, PANEL_TRANSFER_FINISH } from '../../shared/ipc-channels'
import { BrowserWindow, ipcMain, screen } from 'electron'
import log from '../logger'
import {
  startCrossWindowDrag,
  updateCrossWindowCursor,
  cancelCrossWindowDrag,
  claimCrossWindowDrop,
  resolveCrossWindowDrag,
  recordClaim,
  lookupClaim,
  pruneClaims,
  decideDetach,
  isCursorInsideAnyAppWindow,
  CROSS_WINDOW_POLL_MS,
  CROSS_WINDOW_CLAIM_WAIT_MS,
  type CrossWindowDragState,
  type ClaimRecord,
  type GhostHostWindow,
} from '../dragLogic'
import {
  createDragGhostWindow,
  moveDragGhostWindow,
  destroyDragGhostWindow,
  getDragGhostWindow,
} from '../windows/dragGhost'
import { buildSinglePanelDockState } from '../windows/dockState'
import { anyWindowFullscreen } from '../windows/fullscreen'
import { revealWindow } from '../windows/reveal'
import {
  beginTerminalBuffering,
  abortTerminalTransfer,
  setTerminalTransferTarget,
  handleCrossWindowDropTerminalTransfer,
} from './terminal'
import {
  sendToWindow,
  broadcastToAll,
  broadcastToAllExcept,
  windowFromEvent,
  listWindows,
  setDockWindowState,
  retainDockWindowRecovery,
  clearDockWindowRecovery,
} from '../windowRegistry'
import type { CateWindowParams, PanelTransferSnapshot } from '../../shared/types'
import {
  DRAG_DETACH,
  DRAG_END,
  PANEL_RECEIVE,
  DOCK_WINDOW_INIT,
  CROSS_WINDOW_DRAG_START,
  CROSS_WINDOW_DRAG_UPDATE,
  CROSS_WINDOW_DRAG_DROP,
  CROSS_WINDOW_DRAG_CANCEL,
  CROSS_WINDOW_DRAG_RESOLVE,
} from '../../shared/ipc-channels'

interface DragHandlerDeps {
  createWindow: (params?: CateWindowParams) => BrowserWindow
}

export function registerDragHandlers({ createWindow }: DragHandlerDeps): void {
  // Id of the most recently started cross-window drag. Declared up here (above
  // DRAG_DETACH, which references it) but owned by the cross-window section
  // below. Survives the live-state null-out so RESOLVE can look up the claim
  // record by id even when DROP cleared crossWindowDragState before the
  // resolver was armed. Only one drag is in flight at a time (single cursor).
  let lastCrossWindowDragId: string | null = null

  let remoteReceipt: { id: string; targetId: number; done: Promise<void>; complete: (accepted: boolean) => void } | null = null

  const transfers = new Map<string, {
    sourceId: number | undefined; win: BrowserWindow; workspaceId: string; snapshot: PanelTransferSnapshot;
    ready: boolean; committed: boolean; finished: boolean; recoveryIds: Set<number>;
    resolve: (id: number | null) => void; cleanup: () => void;
  }>()
  const terminalIds = (snapshot: PanelTransferSnapshot) => [snapshot.terminalPtyId, ...Object.values(snapshot.canvasState?.childTerminals ?? {}).map(t => t.ptyId)].filter((id): id is string => !!id)
  const cacheTransfer = (transfer: NonNullable<ReturnType<typeof transfers.get>>) => {
    const { snapshot, win } = transfer
    setDockWindowState(win.id, {
      dockState: { zones: buildSinglePanelDockState(snapshot.panel.id) },
      panels: { ...snapshot.canvasState?.childPanels, [snapshot.panel.id]: snapshot.panel },
      rootPath: snapshot.rootPath, worktrees: snapshot.worktrees,
      canvasStates: snapshot.canvasState ? { [snapshot.panel.id]: snapshot.canvasState } : {},
    })
    retainDockWindowRecovery(win.id)
    transfer.recoveryIds.add(win.id)
  }
  ipcMain.handle(PANEL_TRANSFER_READY, (event, transferId: string, phase?: 'received' | 'rejected') => {
    if (remoteReceipt?.id === transferId && windowFromEvent(event)?.id === remoteReceipt.targetId) {
      if (phase === 'received' || phase === 'rejected') remoteReceipt.complete(phase === 'received')
      return
    }
    const transfer = transfers.get(transferId)
    if (!transfer || windowFromEvent(event)?.id !== transfer.win.id) return
    if (phase === 'received') {
      if (!transfer.finished) return
      transfer.cleanup()
      for (const id of transfer.recoveryIds) clearDockWindowRecovery(id)
      transfers.delete(transferId)
      return
    }
    transfer.ready = true
    transfer.resolve(transfer.win.id)
  })
  ipcMain.handle(PANEL_TRANSFER_COMMIT, (event, transferId: string, snapshot: PanelTransferSnapshot | null) => {
    const transfer = transfers.get(transferId)
    if (!transfer || transfer.finished || windowFromEvent(event)?.id !== transfer.sourceId) return false
    if (!snapshot || !transfer.ready || transfer.win.isDestroyed() || snapshot.panel.id !== transfer.snapshot.panel.id) {
      transfer.cleanup(); transfers.delete(transferId)
      for (const id of transfer.recoveryIds) clearDockWindowRecovery(id)
      for (const id of terminalIds(transfer.snapshot)) abortTerminalTransfer(id)
      if (!transfer.win.isDestroyed()) transfer.win.close()
      return false
    }
    transfer.snapshot = { ...snapshot, transferId }
    transfer.committed = true
    cacheTransfer(transfer)
    for (const id of terminalIds(transfer.snapshot)) beginTerminalBuffering(id)
    return true
  })
  ipcMain.on(PANEL_TRANSFER_FINISH, (event, transferId: string, finalSnapshot?: PanelTransferSnapshot) => {
    const transfer = transfers.get(transferId)
    if (!transfer || !transfer.committed || transfer.finished || windowFromEvent(event)?.id !== transfer.sourceId) return
    // Only replay bytes may change after the accepted portable snapshot. The
    // source captured them after COMMIT began buffering, before releasing views.
    if (finalSnapshot?.panel.id === transfer.snapshot.panel.id) {
      transfer.snapshot = { ...transfer.snapshot, terminalScrollback: finalSnapshot.terminalScrollback,
        canvasState: transfer.snapshot.canvasState && { ...transfer.snapshot.canvasState,
          childTerminals: Object.fromEntries(Object.entries(transfer.snapshot.canvasState.childTerminals ?? {}).map(([id, terminal]) => [id, { ...terminal, scrollback: finalSnapshot.canvasState?.childTerminals?.[id]?.scrollback ?? terminal.scrollback }])) } }
    }
    transfer.finished = true
    transfer.cleanup()
    const publish = () => {
      const { win, workspaceId, snapshot } = transfer
      if (win.isDestroyed()) return // retained recovery snapshot remains session-owned
      cacheTransfer(transfer)
      for (const id of terminalIds(snapshot)) setTerminalTransferTarget(id, win.id)
      sendToWindow(win.id, DOCK_WINDOW_INIT, { panels: { [snapshot.panel.id]: snapshot.panel }, dockState: buildSinglePanelDockState(snapshot.panel.id), workspaceId, rootPath: snapshot.rootPath, worktrees: snapshot.worktrees })
      sendToWindow(win.id, PANEL_RECEIVE, snapshot)
      revealWindow(win, { focus: true })
    }
    if (transfer.win.isDestroyed()) {
      try {
        transfer.win = createWindow({ type: 'dock', workspaceId: transfer.workspaceId })
        cacheTransfer(transfer)
        // The replacement now owns the cached snapshot. Keep one session entry.
        for (const id of transfer.recoveryIds) {
          if (id !== transfer.win.id) { clearDockWindowRecovery(id); transfer.recoveryIds.delete(id) }
        }
        transfer.win.webContents.once('did-finish-load', publish)
      } catch (error) {
        // listDockWindows includes the retained orphan in ordinary session saves.
        log.error('[panel-transfer] receiver recreation failed; snapshot retained for recovery', error)
      }
    } else publish()
  })

  ipcMain.handle(DRAG_DETACH, async (event, snapshot: PanelTransferSnapshot, workspaceId?: string) => {
    if (!windowFromEvent(event) || (snapshot.transferId && transfers.has(snapshot.transferId))) return null
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)

    // Decide whether to detach and where to place the new window. `decideDetach`
    // refuses when any Cate window is in macOS native fullscreen (the new window
    // would land in a separate Space and appear black). Caller treats a null
    // return as "detach rejected — put the panel back where it came from".
    const decision = decideDetach({
      anyWindowFullscreen: anyWindowFullscreen(),
      cursor,
      grabOffset: { x: 12, y: 12 },
      size: {
        width: snapshot.geometry?.size?.width ?? 700,
        height: snapshot.geometry?.size?.height ?? 500,
      },
      displayBounds: display.workArea,
    })
    if (decision.kind === 'refuse') return null

    // A dock window without a workspace can never be persisted: session save
    // associates dock windows with workspaces by id, so this window would
    // silently vanish on restart. Detach callers are expected to always pass one.
    if (!workspaceId) {
      log.warn('[drag-detach] no workspaceId for panel %s — window will not survive restart', snapshot.panel.id)
    }

    let newWin: BrowserWindow
    try {
      newWin = createWindow({
        type: 'dock',
        workspaceId,
      })
    } catch (err) {
      // The source still owns the panel and terminal until final acceptance.
      log.error('[drag-detach] window creation failed, detach aborted:', err)
      return null
    }

    newWin.setBounds({
      x: decision.position.x,
      y: decision.position.y,
      width: decision.size.width,
      height: decision.size.height,
    })

    const transferId = snapshot.transferId ?? randomUUID()
    snapshot = { ...snapshot, transferId }
    return await new Promise<number | null>((resolve) => {
      const abandon = () => {
        const transfer = transfers.get(transferId)
        if (transfer?.committed) { transfer.cleanup(); return }
        transfer?.cleanup()
        transfers.delete(transferId)
        resolve(null)
      }
      const timeout = setTimeout(() => { abandon(); if (!newWin.isDestroyed()) newWin.close() }, 30_000)
      const failed = () => { abandon(); if (!newWin.isDestroyed()) newWin.close() }
      const stage = () => sendToWindow(newWin.id, PANEL_TRANSFER_STAGE, { snapshot, workspaceId: workspaceId ?? '' })
      const cleanup = () => {
        clearTimeout(timeout)
        newWin.removeListener('closed', abandon)
        newWin.webContents.removeListener('did-fail-load', failed)
        newWin.webContents.removeListener('did-finish-load', stage)
      }
      transfers.set(transferId, { sourceId: windowFromEvent(event)?.id, win: newWin, workspaceId: workspaceId ?? '', snapshot, ready: false, committed: false, finished: false, recoveryIds: new Set(), resolve, cleanup })
      newWin.once('closed', abandon)
      newWin.webContents.once('did-fail-load', failed)
      newWin.webContents.once('did-finish-load', stage)
      broadcastToAll(DRAG_END, lastCrossWindowDragId ?? undefined)
    })
  })

  ipcMain.on(DRAG_END, () => {
    broadcastToAll(DRAG_END)
  })

  // Cross-window drag coordination — `crossWindowDragState` is the pure state
  // (managed via dragLogic functions); `pollTimer` is the Electron-effect that
  // shadows it. They're cleared together.
  let crossWindowDragState: CrossWindowDragState | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  // Used by CROSS_WINDOW_DRAG_RESOLVE to detect if a target window claimed the
  // drop before the claim-wait timer fires.
  let crossWindowDropClaimedResolve: (() => void) | null = null

  // Claim outcomes keyed by dragId — survive the live-state teardown so a late
  // RESOLVE (one arriving after DROP already cleared crossWindowDragState
  // because no resolver was pending) still reads claimed=true rather than
  // inferring false from a nulled pointer. Pruned to the claim-wait window.
  let crossWindowClaims: Map<string, ClaimRecord> = new Map()

  const stopPollTimer = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  ipcMain.handle(CROSS_WINDOW_DRAG_START, async (event, snapshot: PanelTransferSnapshot, _screenPos: unknown) => {
    const win = windowFromEvent(event)
    if (!win) return

    // Refuse any cross-window drag while any Cate window is in macOS
    // native fullscreen — the drag ghost would land in a different Space
    // (black window). Lock the drag to the source window entirely.
    if (anyWindowFullscreen()) return

    remoteReceipt?.complete(false)
    const cursor = screen.getCursorScreenPoint()
    crossWindowDragState = startCrossWindowDrag({
      dragId: crypto.randomUUID(),
      sourceWindowId: win.id,
      snapshot,
      cursor,
    })
    lastCrossWindowDragId = crossWindowDragState.dragId

    // Create the native drag ghost window — size to match the source panel
    // (canvas-space size; clamped inside createDragGhostWindow).
    createDragGhostWindow(
      snapshot.panel.type,
      snapshot.panel.title,
      snapshot.geometry?.size?.width ?? 320,
      snapshot.geometry?.size?.height ?? 200,
    )

    // Poll cursor position: move ghost, broadcast to all windows EXCEPT source
    pollTimer = setInterval(() => {
      if (!crossWindowDragState) return
      const pos = screen.getCursorScreenPoint()
      crossWindowDragState = updateCrossWindowCursor(crossWindowDragState, pos)
      moveDragGhostWindow(pos.x, pos.y)

      // Hide the native ghost when the cursor is over any Cate window — the
      // in-renderer DragOverlay handles the visual there. Show it again when
      // the cursor leaves all Cate windows (e.g. on the desktop between
      // windows) so the user still has a drag affordance.
      const ghost = getDragGhostWindow()
      if (ghost) {
        const overCateWindow = isCursorInsideAnyAppWindow(
          pos,
          listWindows() as unknown as GhostHostWindow[],
        )
        if (overCateWindow) {
          if (ghost.isVisible()) ghost.hide()
        } else {
          if (!ghost.isVisible()) ghost.showInactive()
        }
      }

      broadcastToAllExcept(crossWindowDragState.sourceWindowId, CROSS_WINDOW_DRAG_UPDATE, pos, crossWindowDragState.snapshot, crossWindowDragState.dragId)
    }, CROSS_WINDOW_POLL_MS)
  })

  ipcMain.handle(CROSS_WINDOW_DRAG_DROP, async (event, panelId: string) => {
    const drag = crossWindowDragState
    const targetWin = windowFromEvent(event)
    if (!drag || drag.claimed || remoteReceipt || drag.snapshot.panel.id !== panelId || !targetWin || targetWin.id === drag.sourceWindowId) return { accepted: false }
    stopPollTimer()
    destroyDragGhostWindow()
    const transferId = randomUUID()
    let settled!: () => void
    const done = new Promise<void>(resolve => { settled = resolve })
    const failed = () => complete(false)
    const timer = setTimeout(failed, 5_000)
    const complete = (accepted: boolean): void => {
      if (remoteReceipt?.id !== transferId) return
      clearTimeout(timer)
      targetWin.removeListener('closed', failed)
      targetWin.webContents.removeListener('render-process-gone', failed)
      remoteReceipt = null
      if (accepted) {
        crossWindowDragState = claimCrossWindowDrop(crossWindowDragState, Date.now())
        const now = Date.now()
        crossWindowClaims = recordClaim(pruneClaims(crossWindowClaims, now, CROSS_WINDOW_CLAIM_WAIT_MS), drag.dragId, true, now)
        sendToWindow(drag.sourceWindowId, DRAG_END, drag.dragId)
      }
      if (!accepted) for (const id of terminalIds(drag.snapshot)) abortTerminalTransfer(id)
      settled()
      // Only a hydrated target may release the source. Otherwise RESOLVE can
      // safely use the normal detach fallback, preserving its live document.
      if (crossWindowDropClaimedResolve) crossWindowDropClaimedResolve()
      else crossWindowDragState = cancelCrossWindowDrag(crossWindowDragState)
    }
    for (const id of terminalIds(drag.snapshot)) handleCrossWindowDropTerminalTransfer(id, targetWin.id)
    remoteReceipt = { id: transferId, targetId: targetWin.id, done, complete }
    targetWin.once('closed', failed)
    targetWin.webContents.once('render-process-gone', failed)
    return { accepted: true, transferId }
  })

  ipcMain.handle(CROSS_WINDOW_DRAG_CANCEL, async () => {
    remoteReceipt?.complete(false)
    if (!crossWindowDragState) return
    stopPollTimer()
    const dragId = crossWindowDragState.dragId
    crossWindowDragState = cancelCrossWindowDrag(crossWindowDragState)
    destroyDragGhostWindow()
    broadcastToAll(DRAG_END, dragId)
  })

  // Resolve cross-window drag on mouseup from source window.
  // Broadcasts DRAG_END, waits briefly for a target window to claim via
  // CROSS_WINDOW_DRAG_DROP, then returns whether the drop was claimed. If not,
  // source falls back to DRAG_DETACH.
  ipcMain.handle(CROSS_WINDOW_DRAG_RESOLVE, async () => {
    // The live state may already be gone if a DROP landed (and cleared it)
    // before this RESOLVE arrived. In that case the claim outcome lives in the
    // dragId-keyed record, NOT in the (nulled) pointer — read it there so a
    // just-completed claim isn't misread as unclaimed (which would duplicate
    // the panel via a fallback detach).
    if (!crossWindowDragState) {
      const dragId = lastCrossWindowDragId
      const claimed = dragId
        ? lookupClaim(crossWindowClaims, dragId, Date.now(), CROSS_WINDOW_CLAIM_WAIT_MS)
        : false
      return { claimed }
    }

    const sourceId = crossWindowDragState.sourceWindowId
    const dragId = crossWindowDragState.dragId

    // Stop polling but keep the state alive so DROP can still claim it within
    // the short wait window below.
    stopPollTimer()
    const stateAtResolve = { ...crossWindowDragState, resolvedAt: Date.now() }
    crossWindowDragState = stateAtResolve

    destroyDragGhostWindow()

    // Broadcast DRAG_END to non-source windows so target windows check their
    // drop targets. The dragId lets each window force-end only ITS OWN remote
    // drag (a window with an unrelated active drag ignores this).
    broadcastToAllExcept(sourceId, DRAG_END, dragId)

    // Wait briefly for a target window to call CROSS_WINDOW_DRAG_DROP.
    return new Promise<{ claimed: boolean }>((resolve) => {
      const finish = (now: number): void => {
        crossWindowDropClaimedResolve = null
        // Decide from the live state if present, else fall back to the claim
        // record (covers a DROP that cleared the pointer between arming and
        // firing the resolver).
        const liveDecision = resolveCrossWindowDrag(crossWindowDragState)
        const claimed =
          liveDecision.claimed ||
          lookupClaim(crossWindowClaims, dragId, now, CROSS_WINDOW_CLAIM_WAIT_MS)
        crossWindowDragState = cancelCrossWindowDrag(crossWindowDragState)
        resolve({ claimed })
      }

      const timeout = setTimeout(() => {
        if (remoteReceipt) void remoteReceipt.done.then(() => { if (crossWindowDropClaimedResolve) finish(Date.now()) })
        else finish(Date.now())
      }, CROSS_WINDOW_CLAIM_WAIT_MS)

      crossWindowDropClaimedResolve = () => {
        clearTimeout(timeout)
        finish(Date.now())
      }
    })
  })
}
