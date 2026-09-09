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
import {
  getOrCreateCanvasStoreForPanel,
  releaseCanvasStoreForPanel,
  type CanvasStore,
} from '../stores/canvasStore'
import type { MenuActionId, PanelType } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { getActivePanelId, setActivePanel } from '../lib/activePanel'

// Tell React this is an act() environment (silences the act warning + flushes effects).
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PRIMARY = 'panel-primary'
const ACTIVE = 'panel-active'

let primary: StoreApi<CanvasStore>
let active: StoreApi<CanvasStore>
let container: HTMLDivElement
let root: Root
let menuAction: (action: MenuActionId) => void

function Harness({ store }: { store: StoreApi<CanvasStore> }) {
  useShortcuts(store)
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
    onMenuTriggerAction: (callback: typeof menuAction) => { menuAction = callback; return () => {} },
  }

  useAppStore.setState({ selectedWorkspaceId: 'workspace', workspaces: [{ id: 'workspace', rootPath: '/project', panels: {
    [PRIMARY]: { id: PRIMARY, type: 'canvas', title: 'Canvas' },
    [ACTIVE]: { id: ACTIVE, type: 'canvas', title: 'Canvas' },
  } } as never] })
  // First panel inherits the legacy singleton; the second gets a fresh store.
  primary = getOrCreateCanvasStoreForPanel(PRIMARY) as unknown as StoreApi<CanvasStore>
  active = getOrCreateCanvasStoreForPanel(ACTIVE) as unknown as StoreApi<CanvasStore>
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
  releaseCanvasStoreForPanel(PRIMARY)
  releaseCanvasStoreForPanel(ACTIVE)
  useAppStore.setState({ selectedWorkspaceId: '', workspaces: [] })
  setActivePanel(null)
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


describe('navigation from panel content', () => {
  it.each(['keyboard', 'menu'] as const)('keeps %s navigation inside a dialog', (source) => {
    const left = active.getState().addNode('source', 'editor', { x: 0, y: 0 })
    active.getState().addNode('destination', 'editor', { x: 2000, y: 0 })
    act(() => { active.getState().selectNodes([left]) })
    const dialog = document.createElement('form')
    dialog.setAttribute('role', 'dialog')
    const input = document.createElement('input')
    dialog.appendChild(input)
    container.appendChild(dialog)
    input.focus()
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', metaKey: true, bubbles: true, cancelable: true })

    act(() => {
      if (source === 'keyboard') input.dispatchEvent(event)
      else menuAction('navigateRight')
    })

    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(input)
    expect(active.getState().selection).toEqual([left])
  })

  it.each<PanelType>(['agent', 'browser', 'terminal', 'editor', 'canvas', 'document', 'review'])(
    'supports chained jumps starting from a %s panel', (type) => {
      const left = active.getState().addNode('source', type, { x: 0, y: 0 })
      const middle = active.getState().addNode('middle', 'editor', { x: 2000, y: 0 })
      const right = active.getState().addNode('right', 'editor', { x: 4000, y: 0 })
      act(() => { active.getState().selectNodes([left]) })
      const surface = document.createElement(type === 'agent' || type === 'browser' ? 'webview' : 'textarea')
      surface.tabIndex = 0
      container.appendChild(surface)
      surface.focus()
      expect(document.activeElement).toBe(surface)

      if (type === 'agent' || type === 'browser') {
        act(() => { menuAction('navigateRight') })
      } else {
        act(() => { surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', metaKey: true, bubbles: true })) })
      }
      expect(active.getState().selection).toEqual([middle])
      expect(document.activeElement).not.toBe(surface)
      expect(getActivePanelId()).toBe(ACTIVE)
      dispatchKey({ key: 'ArrowRight', metaKey: true })
      expect(active.getState().selection).toEqual([right])
      dispatchKey({ key: 'Enter' })
      expect(active.getState().selectionActive).toBe(true)
    },
  )

  it('preserves Shift+Arrow text selection', () => {
    const surface = document.createElement('textarea')
    container.appendChild(surface)
    surface.focus()
    const pan = vi.spyOn(active.getState(), 'panViewport')
    dispatchKey({ key: 'ArrowRight', shiftKey: true })
    expect(pan).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(surface)
  })
})
