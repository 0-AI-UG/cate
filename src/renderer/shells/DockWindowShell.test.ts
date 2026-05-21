// =============================================================================
// Targeted tests for the bits of DockWindowShell that pin a previous bug:
// when the last tab is dragged out of a detached dock window, the window
// must close. The fix is a `dockStore.subscribe` in the shell; here we cover
// the underlying pure check (`isDockEmpty`) and verify the transition the
// subscription watches for actually fires on a real DockStore.
//
// We don't mount the React shell — DOCK_WINDOW_INIT requires a populated
// electronAPI + Suspense boundary which isn't worth standing up for one
// guard. Instead we drive the same dock store directly.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { createDockStore } from '../stores/dockStore'
import { isDockEmpty } from './dockEmpty'
// Regression: detached dock window stays open as an empty shell when the
// last tab is dragged out via commit.ts's programmatic undockPanel. The
// inline guard in DockWindowShell additionally requires the local React
// `panels` map to be empty, but nothing clears it on undock → window leaks.
// The fix moves the decision to this helper without the local-panels guard.
import { shouldCloseDockWindow } from './shouldCloseDockWindow'

describe('isDockEmpty', () => {
  it('returns true for a freshly-created dock store (no panels)', () => {
    const store = createDockStore()
    expect(isDockEmpty(store.getState())).toBe(true)
  })

  it('returns false after a panel is docked', () => {
    const store = createDockStore()
    store.getState().dockPanel('p1', 'center')
    expect(isDockEmpty(store.getState())).toBe(false)
  })

  it('returns true again after the last panel is undocked', () => {
    const store = createDockStore()
    store.getState().dockPanel('p1', 'center')
    expect(isDockEmpty(store.getState())).toBe(false)
    store.getState().undockPanel('p1')
    expect(isDockEmpty(store.getState())).toBe(true)
  })

  it('returns false when one zone holds a layout even if others are empty', () => {
    const store = createDockStore()
    store.getState().dockPanel('p1', 'right')
    expect(isDockEmpty(store.getState())).toBe(false)
  })
})

describe('dockStore subscribe — last-tab-undock signal', () => {
  // This pins the contract the shell's useEffect relies on: undocking the
  // last panel must fire a store update AND leave the resulting state empty.
  // If a future change to dockStore stops firing on full-empty transitions,
  // the auto-close-on-empty UX silently breaks.

  it('fires subscribe on the final undock with an empty state', () => {
    const store = createDockStore()
    store.getState().dockPanel('p1', 'center')
    store.getState().dockPanel('p2', 'center')

    let emptyTransitions = 0
    const unsub = store.subscribe(() => {
      if (isDockEmpty(store.getState())) emptyTransitions++
    })

    // Removing the first of two panels does NOT empty the dock.
    store.getState().undockPanel('p1')
    expect(emptyTransitions).toBe(0)

    // Removing the last panel transitions to empty.
    store.getState().undockPanel('p2')
    expect(emptyTransitions).toBeGreaterThan(0)

    unsub()
  })

  it('a programmatic undock (the path commit.ts takes) is observable by subscribers', () => {
    // This is the exact bug we're guarding against: when a cross-window drop
    // is claimed, commit.ts calls undockPanel directly — not via the UI X
    // button. The shell's auto-close logic must see this transition too.
    const store = createDockStore()
    store.getState().dockPanel('only-tab', 'center')

    let sawEmpty = false
    const unsub = store.subscribe(() => {
      if (isDockEmpty(store.getState())) sawEmpty = true
    })

    // Mimic the commit.ts code path: origin.dockStoreApi.getState().undockPanel(panelId)
    store.getState().undockPanel('only-tab')

    expect(sawEmpty).toBe(true)
    unsub()
  })
})

describe('shouldCloseDockWindow — pins the auto-close-when-empty rule', () => {
  it('returns false on initial mount (empty dock, never had panels)', () => {
    expect(shouldCloseDockWindow({ isDockEmpty: true, hasEverHadPanels: false })).toBe(false)
  })

  it('returns false while panels exist', () => {
    expect(shouldCloseDockWindow({ isDockEmpty: false, hasEverHadPanels: true })).toBe(false)
  })

  it('returns TRUE after the last tab is undocked, regardless of the local panels-map state', () => {
    // The current inline check in DockWindowShell also gates on
    // `Object.keys(panels).length === 0`. That local map is never cleared
    // when commit.ts undocks a tab → gate never trips → window stays open.
    // The helper must NOT require that condition.
    expect(shouldCloseDockWindow({ isDockEmpty: true, hasEverHadPanels: true })).toBe(true)
  })
})
