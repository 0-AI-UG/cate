// =============================================================================
// Auto-save (idle debounce + max-wait + periodic unconditional save)
//
// Rationale: a pure trailing debounce never flushes during sustained activity
// (continuous canvas drag, typing into editor). We want background persistence
// with bounded data loss, without saving on every frame of a drag.
//
// - IDLE_DELAY: save this long after the last change (covers quiet periods)
// - MAX_WAIT:   guaranteed flush during sustained activity
// - PERIODIC_INTERVAL: unconditional periodic save to protect against crashes
// saveSession itself is async + IPC, so it doesn't block the render thread.
// =============================================================================

import type { StoreApi } from 'zustand'
import { useAppStore } from '../../stores/appStore'
import { useUIStore } from '../../stores/uiStore'
import { getWorkspaceCanvasPanelIds } from './canvasAccess'
import { peekCanvasStoreForPanel } from '../../stores/canvasStore'
import { getOrCreateWorkspaceDockStore } from './dockRegistry'
import { saveSession } from './sessionSave'
import type { CanvasStore } from '../../stores/canvasStore'
import type { DockStore } from '../../stores/dockStore'

const IDLE_DELAY = 500
const MAX_WAIT = 4000
const PERIODIC_INTERVAL = 30_000

let idleTimer: ReturnType<typeof setTimeout> | null = null
let maxWaitTimer: ReturnType<typeof setTimeout> | null = null
let periodicTimer: ReturnType<typeof setInterval> | null = null

// Don't let a pending autosave timer keep a process alive on its own. In the
// browser/Electron renderer `setTimeout` returns a number (no `.unref`), so this
// is a no-op there and the timer behaves normally; under the Node test runner the
// handle is a Timeout object and unref'ing it lets vitest exit instead of hanging
// on the periodic-save interval. The timer still fires while the app is running.
function unrefTimer<T>(t: T): T {
  const h = t as unknown as { unref?: () => void }
  if (h && typeof h === 'object' && typeof h.unref === 'function') h.unref()
  return t
}
let pendingSave = false
let saveInFlight = false
let autoSaveSetUp = false
// Restore gate — while a workspace restore is hydrating stores, the store
// subscriptions below fire with TRANSIENT half-built state (panels recreated
// but canvases not yet seeded, teardown's momentary empty layout, …). Saving
// that state is how a rich on-disk layout gets clobbered by an empty one
// (issue #220). This gate suppresses scheduling at the source; the main
// process's empty-overwrite/richness guards remain as backstops. A counter,
// not a boolean: multi-workspace startup can overlap restores.
let restoreDepth = 0
// "Dirty since last save" flag — set by every store subscription that schedules
// a save, cleared after a successful write. Lets the quit flush skip the IPC
// round-trip entirely when there's nothing to persist.
let sessionDirty = false
// Resolvers for flush requests waiting on an in-flight save to finish
let flushWaiters: (() => void)[] = []

function runSave(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null }
  if (!pendingSave) return
  pendingSave = false
  if (saveInFlight) {
    // A save is already running; mark dirty so the next scheduler tick re-runs.
    pendingSave = true
    return
  }
  saveInFlight = true
  // Snapshot dirty at the moment the save begins; further mutations re-set it.
  sessionDirty = false
  saveSession()
    .catch(() => {
      // Save failed — re-mark dirty so the next flush still writes.
      sessionDirty = true
    })
    .finally(() => {
      saveInFlight = false
      // Notify any flush waiters that the save completed
      const waiters = flushWaiters
      flushWaiters = []
      for (const resolve of waiters) resolve()
      // If more changes arrived while saving, re-arm idle timer.
      if (pendingSave) scheduleSave()
    })
}

function scheduleSave(): void {
  // Hydrating — transient restore state must never be persisted.
  if (restoreDepth > 0) return
  pendingSave = true
  sessionDirty = true
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = unrefTimer(setTimeout(runSave, IDLE_DELAY))
  if (!maxWaitTimer) {
    maxWaitTimer = unrefTimer(setTimeout(runSave, MAX_WAIT))
  }
}

/** Suppress session autosave while a workspace restore hydrates the stores.
 *  Returns an `end` callback (idempotent); when the LAST overlapping restore
 *  ends, one save is scheduled so the final fully-hydrated state persists. */
export function beginRestoreQuiescence(): () => void {
  restoreDepth++
  let ended = false
  return () => {
    if (ended) return
    ended = true
    restoreDepth--
    if (restoreDepth === 0) scheduleSave()
  }
}

export function setupAutoSave(): () => void {
  if (autoSaveSetUp) {
    return () => {}
  }
  autoSaveSetUp = true

  // Each workspace owns its dock + canvas stores, so there is no single store to
  // subscribe to. Track the ACTIVE workspace's dock store AND every one of its
  // live canvas stores (primary + secondaries) — a geometry edit (move/resize/
  // pan/zoom) on a secondary canvas must mark the session dirty too, or the quit
  // flush ACKs without saving it. We re-evaluate on every appStore change
  // (selection switch, panel add/remove), which also catches a secondary canvas
  // store created lazily for the active workspace. Canvas subscriptions are
  // keyed by panel id and diffed in/out so a canvas added/removed mid-session
  // gains/loses its listener without churning the others.
  let curDock: StoreApi<DockStore> | null = null
  let dockUnsub: (() => void) | null = null
  const canvasUnsubs = new Map<string, () => void>()
  const subscribeActive = () => {
    const wsId = useAppStore.getState().selectedWorkspaceId || null
    const dock = wsId ? getOrCreateWorkspaceDockStore(wsId) : null
    if (dock !== curDock) {
      curDock = dock
      dockUnsub?.()
      dockUnsub = dock ? dock.subscribe(scheduleSave) : null
    }

    // Live canvas stores for the active workspace, keyed by canvas panel id. Only
    // mounted stores are subscribed — an unmounted secondary canvas can't be
    // edited, so it has nothing to dirty until it mounts (which fires an appStore
    // change that re-runs this).
    const liveCanvasIds = new Set<string>()
    const canvasStores = new Map<string, StoreApi<CanvasStore>>()
    if (wsId) {
      for (const panelId of getWorkspaceCanvasPanelIds(wsId)) {
        const store = peekCanvasStoreForPanel(panelId)
        if (store) {
          liveCanvasIds.add(panelId)
          canvasStores.set(panelId, store)
        }
      }
    }
    for (const [panelId, unsub] of canvasUnsubs) {
      if (!liveCanvasIds.has(panelId)) {
        unsub()
        canvasUnsubs.delete(panelId)
      }
    }
    for (const [panelId, store] of canvasStores) {
      if (!canvasUnsubs.has(panelId)) {
        canvasUnsubs.set(panelId, store.subscribe(scheduleSave))
      }
    }
  }
  const unsubActive = () => {
    dockUnsub?.()
    dockUnsub = null
    curDock = null
    for (const unsub of canvasUnsubs.values()) unsub()
    canvasUnsubs.clear()
  }
  const unsubApp = useAppStore.subscribe(() => {
    subscribeActive()
    scheduleSave()
  })
  // Most uiStore state is deliberately transient (hover, marquee, dialogs).
  // Only the two worktree scope maps belong in the machine-local session, so
  // watch their references explicitly instead of autosaving on every UI edit.
  const unsubUI = useUIStore.subscribe((state, previous) => {
    if (
      state.navigationWorktreeByWorkspace !== previous.navigationWorktreeByWorkspace
      || state.sourceControlWorktreeByRepository !== previous.sourceControlWorktreeByRepository
    ) {
      scheduleSave()
    }
  })
  subscribeActive()

  // Unconditional periodic save — ensures on-disk state is never more than
  // PERIODIC_INTERVAL stale, even without detected store changes. Protects
  // against crashes, force-kills, and update restarts.
  periodicTimer = unrefTimer(setInterval(() => {
    if (restoreDepth > 0) return
    if (pendingSave) {
      runSave()
    } else if (!saveInFlight) {
      // Force a save even without detected changes — workspace sync may have
      // drifted or external state (terminal CWD) changed without store updates.
      pendingSave = true
      runSave()
    }
  }, PERIODIC_INTERVAL))

  // Listen for flush-save requests from main process (quit, window close)
  const unsubFlush = window.electronAPI.onSessionFlushSave(() => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null }

    // Quitting mid-restore: the on-disk session IS the state being restored —
    // persisting half-hydrated stores could only degrade it. ACK without saving.
    if (restoreDepth > 0) {
      window.electronAPI.sessionFlushSaveDone()
      return
    }

    // Phase 4.3: skip the round-trip entirely when nothing has changed since
    // the last successful save. Cuts quit latency for read-only sessions.
    if (!sessionDirty && !pendingSave && !saveInFlight) {
      window.electronAPI.sessionFlushSaveDone()
      return
    }

    const doFlushSave = () => {
      saveInFlight = true
      pendingSave = false
      sessionDirty = false
      saveSession()
        .catch(() => { sessionDirty = true })
        .finally(() => {
          saveInFlight = false
          window.electronAPI.sessionFlushSaveDone()
        })
    }

    if (saveInFlight) {
      // A save is already in flight — wait for it to finish, then run a
      // fresh save with current state before sending the ACK.
      flushWaiters.push(doFlushSave)
    } else {
      doFlushSave()
    }
  })

  return () => {
    unsubActive()
    unsubApp()
    unsubUI()
    unsubFlush()
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null }
    if (periodicTimer) { clearInterval(periodicTimer); periodicTimer = null }
    autoSaveSetUp = false
  }
}
