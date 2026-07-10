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
  abortTerminalTransfer,
  beginTerminalBuffering,
  setTerminalTransferTarget,
  handleCrossWindowDropTerminalTransfer,
} from './terminal'
import {
  sendToWindow,
  broadcastToAll,
  broadcastToAllExcept,
  windowFromEvent,
  listWindows,
} from '../windowRegistry'
import type { CateWindowParams, DockWindowInitPayload, PanelTransferSnapshot } from '../../shared/types'
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

  ipcMain.handle(DRAG_DETACH, async (_event, snapshot: PanelTransferSnapshot, workspaceId?: string) => {
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

    // Collect every live PTY that must move with the panel. For a canvas, each
    // child terminal is its own PTY that must transfer too. (Restore entries —
    // replayPtyId — spawn fresh in the new window, so they don't buffer.)
    const transferPtyIds: string[] = []
    if (snapshot.terminalPtyId) transferPtyIds.push(snapshot.terminalPtyId)
    for (const t of Object.values(snapshot.canvasState?.childTerminals ?? {})) {
      if (t.ptyId) transferPtyIds.push(t.ptyId)
    }

    // Buffer their output for the duration of the handoff so nothing is lost
    // between detach and the new window reconnecting. No destination yet — the
    // window doesn't exist; if creation fails the buffers flush back to source.
    for (const ptyId of transferPtyIds) beginTerminalBuffering(ptyId)

    let newWin: BrowserWindow
    try {
      newWin = createWindow({
        type: 'dock',
        workspaceId,
      })
    } catch (err) {
      // The move is off: flush held output back to the source window (where the
      // panel still lives) instead of leaving a destination-less transfer armed.
      for (const ptyId of transferPtyIds) abortTerminalTransfer(ptyId)
      log.error('[drag-detach] window creation failed, detach aborted:', err)
      return null
    }

    // Point the armed transfers at the new window
    for (const ptyId of transferPtyIds) setTerminalTransferTarget(ptyId, newWin.id)

    newWin.setBounds({
      x: decision.position.x,
      y: decision.position.y,
      width: decision.size.width,
      height: decision.size.height,
    })

    // Build initial dock state: single center zone with one tab stack
    const initPayload: DockWindowInitPayload = {
      panels: { [snapshot.panel.id]: snapshot.panel },
      dockState: buildSinglePanelDockState(snapshot.panel.id),
      workspaceId: workspaceId ?? '',
      rootPath: snapshot.rootPath,
      worktrees: snapshot.worktrees,
    }

    // Send the init payload + transfer snapshot once the window is ready
    newWin.webContents.once('did-finish-load', () => {
      sendToWindow(newWin.id, DOCK_WINDOW_INIT, initPayload)
      sendToWindow(newWin.id, PANEL_RECEIVE, snapshot)
      // Force show + focus — on macOS in fullscreen, the new window may not
      // auto-show because the OS thinks it belongs to a different Space.
      // (revealWindow skips the focus and stays inactive under e2e.)
      revealWindow(newWin, { focus: true })
    })

    // End only the just-finished cross-window drag (if any) in other windows —
    // a window tracking a DIFFERENT active drag must not be force-ended here.
    // (DRAG_DETACH is the fallback when no window claimed the cross-window drop,
    // so the relevant remote drag is the last-started one.)
    broadcastToAll(DRAG_END, lastCrossWindowDragId ?? undefined)

    return newWin.id
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

  ipcMain.handle(CROSS_WINDOW_DRAG_DROP, async (event, _panelId: string) => {
    // Main is the ARBITER of the drop. Accept iff a live, unclaimed drag is in
    // flight. A DROP arriving after the drag resolved unclaimed (live state
    // nulled — the source has already fallen back to a detach window) or after
    // another claim is REFUSED, and the caller must not materialize the panel:
    // accepting late would duplicate it.
    if (!crossWindowDragState || crossWindowDragState.claimed) {
      destroyDragGhostWindow()
      return { accepted: false }
    }

    stopPollTimer()
    // Mark the state as claimed (pure transition). The resolver below reads
    // `claimed` to decide whether to tell the source to remove its node.
    crossWindowDragState = claimCrossWindowDrop(crossWindowDragState, Date.now())
    // Record the claim keyed by dragId so a RESOLVE that arrives AFTER this
    // DROP clears the live state (the no-resolver branch below) still sees
    // claimed=true — preventing a duplicate detach. Pruned on every write.
    const now = Date.now()
    crossWindowClaims = pruneClaims(crossWindowClaims, now, CROSS_WINDOW_CLAIM_WAIT_MS)
    crossWindowClaims = recordClaim(crossWindowClaims, crossWindowDragState!.dragId, true, now)
    // Arm terminal-ownership transfer to the target (receiver) window — the
    // receiver's reconnectTerminal will panelTransferAck after wiring its
    // listeners, and ack is a no-op without a prior begin.
    const targetWin = BrowserWindow.fromWebContents(event.sender)
    if (targetWin) {
      if (crossWindowDragState!.snapshot.terminalPtyId) {
        handleCrossWindowDropTerminalTransfer(
          crossWindowDragState!.snapshot.terminalPtyId,
          targetWin.id,
        )
      }
      // A canvas carries its child terminals — arm each live PTY for the
      // receiver. (Cross-window drag is always a live transfer, so every entry
      // has a ptyId; the guard satisfies the now-optional type.)
      for (const t of Object.values(crossWindowDragState!.snapshot.canvasState?.childTerminals ?? {})) {
        if (t.ptyId) handleCrossWindowDropTerminalTransfer(t.ptyId, targetWin.id)
      }
    }
    // Notify source window to remove the panel (carry the dragId so an
    // unrelated active drag in that window isn't force-ended).
    sendToWindow(crossWindowDragState!.sourceWindowId, DRAG_END, crossWindowDragState!.dragId)
    destroyDragGhostWindow()

    // Fire the pending resolver (if any). It will read `claimed=true` from
    // the state above and resolve `{ claimed: true }` to the source window.
    // The resolver is also responsible for nullifying `crossWindowDragState`.
    if (crossWindowDropClaimedResolve) {
      crossWindowDropClaimedResolve()
    } else {
      // No resolve in flight — clear the LIVE state directly. The claim is
      // preserved in crossWindowClaims (recorded above, keyed by dragId), so a
      // RESOLVE arriving after this still reads claimed=true rather than
      // inferring false from the nulled pointer (which would duplicate the
      // panel via a fallback detach).
      crossWindowDragState = cancelCrossWindowDrag(crossWindowDragState)
    }
    return { accepted: true }
  })

  ipcMain.handle(CROSS_WINDOW_DRAG_CANCEL, async () => {
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

      const timeout = setTimeout(() => finish(Date.now()), CROSS_WINDOW_CLAIM_WAIT_MS)

      crossWindowDropClaimedResolve = () => {
        clearTimeout(timeout)
        finish(Date.now())
      }
    })
  })
}
