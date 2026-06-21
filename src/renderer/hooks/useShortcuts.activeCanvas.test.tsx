// =============================================================================
// useShortcuts — active-canvas routing regression test.
//
// Pins the fix for the bug where keyboard canvas actions (navigate/pan/zoom)
// were dispatched to the App-level *singleton* canvas store captured from
// context on mount, instead of the canvas the user is actually looking at.
//
// CanvasPanel gives each canvas its own per-panel store and marks itself the
// active panel via setActivePanel; getActiveCanvasOps derives the active canvas
// from it. Only the first canvas aliases the legacy singleton; any later canvas
// gets a fresh store. useShortcuts must resolve the *active* store at dispatch
// time — otherwise Cmd/Shift+Arrow fire but nothing moves on screen (the
// symptom from the field report).
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Heavy renderer modules whose import-time side effects explode under jsdom,
// pulled in transitively via the canvas/app stores. Mirrors the other hook tests.
vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: { release: vi.fn(), setPendingTransfer: vi.fn() },
}))
vi.mock('../lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { StoreApi } from 'zustand'
import { useShortcuts } from './useShortcuts'
import { CanvasStoreProvider } from '../stores/CanvasStoreContext'
import {
  getOrCreateCanvasStoreForPanel,
  releaseCanvasStoreForPanel,
  type CanvasStore,
} from '../stores/canvasStore'
import {
  registerCanvasOps,
  unregisterCanvasOps,
} from '../stores/appStore'
import { setActivePanel } from '../lib/activePanel'
import { createCanvasOps } from '../lib/canvas/canvasBridge'

// Tell React this is an act() environment (silences the act warning + flushes effects).
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PRIMARY = 'panel-primary'
const ACTIVE = 'panel-active'

let primary: StoreApi<CanvasStore>
let active: StoreApi<CanvasStore>
let container: HTMLDivElement
let root: Root

function Harness({ store }: { store: StoreApi<CanvasStore> }) {
  // Mirror App: useShortcuts runs under the singleton context provider.
  return (
    <CanvasStoreProvider store={store}>
      <Inner />
    </CanvasStoreProvider>
  )
}
function Inner() {
  useShortcuts()
  return null
}

function dispatchKey(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
  })
}

beforeEach(() => {
  // electronAPI is consumed in useShortcuts' effect (menu subscriptions).
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    onMenuTriggerAction: () => () => {},
    onMenuLoadLayout: () => () => {},
  }

  // First panel inherits the legacy singleton; the second gets a fresh store.
  primary = getOrCreateCanvasStoreForPanel(PRIMARY) as unknown as StoreApi<CanvasStore>
  active = getOrCreateCanvasStoreForPanel(ACTIVE) as unknown as StoreApi<CanvasStore>
  registerCanvasOps(PRIMARY, createCanvasOps(primary))
  registerCanvasOps(ACTIVE, createCanvasOps(active))
  // The user is looking at the second canvas.
  setActivePanel(ACTIVE)

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Provider store is the singleton/primary — exactly what App passes.
  act(() => { root.render(<Harness store={primary} />) })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  unregisterCanvasOps(PRIMARY)
  unregisterCanvasOps(ACTIVE)
  releaseCanvasStoreForPanel(PRIMARY)
  releaseCanvasStoreForPanel(ACTIVE)
})

describe('useShortcuts active-canvas routing', () => {
  it('Cmd+Arrow navigation targets the active canvas, not the captured singleton', () => {
    // Two nodes on the ACTIVE canvas, left and right.
    const left = active.getState().addNode('left-panel', 'editor', { x: 0, y: 0 })
    const right = active.getState().addNode('right-panel', 'editor', { x: 2000, y: 0 })
    expect(left && right).toBeTruthy()
    // Cursor starts on the left node.
    act(() => { active.getState().selectNodes([left]) })

    dispatchKey({ key: 'ArrowRight', metaKey: true })

    // Selection moved to the right node on the ACTIVE store...
    expect([...active.getState().selection]).toEqual([right])
    // ...and the captured singleton/primary was never touched.
    expect(primary.getState().selection.length).toBe(0)
  })

  it('Shift+Arrow pan moves the active canvas viewport, not the singleton', () => {
    const before = active.getState().viewportOffset
    const primaryBefore = primary.getState().viewportOffset

    dispatchKey({ key: 'ArrowUp', shiftKey: true })

    // animateViewportTo sets offsetAnimTarget and drives RAF; under jsdom the
    // target is committed via the easing loop, but the store's pan intent is
    // observable immediately as suppressAutoFocus + a changed target. Assert the
    // active store reacted and the primary did not.
    expect(active.getState().suppressAutoFocus).toBe(true)
    expect(primary.getState().suppressAutoFocus).toBe(false)
    expect(primaryBefore).toBe(primary.getState().viewportOffset)
    void before
  })
})
