// =============================================================================
// Regression test for useSidebarLayout.
//
// normalizeSidebarLayout builds a fresh {left,right} on every call. Selecting it
// directly inside useSettingsStore(selector) returned a new reference each render
// which, under zustand v5's snapshot-identity check, spun useSyncExternalStore
// into "Maximum update depth exceeded" the moment the sidebar mounted. The hook
// must select the stable raw field and normalize in a memo, so it mounts once and
// keeps a stable reference across unrelated settings changes.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

import { useSidebarLayout, normalizeSidebarLayout, useUIStore } from './uiStore'
import { useSettingsStore } from './settingsStore'
import type { SidebarLayout } from '../../shared/types'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

let renderCount = 0
let lastLayout: SidebarLayout | null = null

function Probe(): React.ReactElement {
  renderCount++
  lastLayout = useSidebarLayout()
  return <div />
}

describe('useSidebarLayout', () => {
  it('mounts without an update loop and keeps a stable reference across unrelated settings changes', () => {
    renderCount = 0
    lastLayout = null

    // A new-reference-per-render selector throws "Maximum update depth exceeded"
    // synchronously here; a couple of renders for mount is fine.
    act(() => {
      root.render(<Probe />)
    })
    const mountRenders = renderCount
    expect(mountRenders).toBeLessThanOrEqual(2)
    const firstRef = lastLayout
    expect(firstRef).not.toBeNull()

    // An unrelated settings change must not produce a new layout reference (and
    // must not re-render the consumer at all, since the selected field is equal).
    act(() => {
      useSettingsStore.setState({ _loaded: true })
    })
    expect(lastLayout).toBe(firstRef)
    expect(renderCount).toBe(mountRenders)
  })
})

// ---------------------------------------------------------------------------
// moveSidebarView + left-sidebar state (drag-and-drop between rails)
// ---------------------------------------------------------------------------

describe('moveSidebarView', () => {
  // A full layout covering all five views, so normalizeSidebarLayout appends
  // nothing and the move math is exact.
  function seedLayout(layout: SidebarLayout) {
    // Stub setSetting so it writes state without the (unmocked) settingsSet IPC.
    const setSetting = vi.fn((key: string, value: unknown) =>
      useSettingsStore.setState({ [key]: value } as never),
    )
    useSettingsStore.setState({ sidebarLayout: layout, setSetting } as never)
    return setSetting
  }

  afterEach(() => {
    useUIStore.setState({ activeLeftSidebarView: 'workspaces', activeRightSidebarView: null })
  })

  it('moves a view across rails, persists the layout, and focuses it on the target side', () => {
    const setSetting = seedLayout({ left: ['workspaces', 'explorer', 'search'], right: ['git', 'cateAgent'] })
    useUIStore.setState({ activeLeftSidebarView: 'explorer', activeRightSidebarView: null })

    useUIStore.getState().moveSidebarView('explorer', 'right', 0)

    expect(setSetting).toHaveBeenCalledTimes(1)
    const [key, value] = setSetting.mock.calls[0]
    expect(key).toBe('sidebarLayout')
    expect((value as SidebarLayout).left).toEqual(['workspaces', 'search'])
    expect((value as SidebarLayout).right).toEqual(['explorer', 'git', 'cateAgent'])
    // Was active on the source (left) → cleared there, focused on the target.
    expect(useUIStore.getState().activeLeftSidebarView).toBeNull()
    expect(useUIStore.getState().activeRightSidebarView).toBe('explorer')
  })

  it('reorders within a rail, adjusting the index for the removed source', () => {
    seedLayout({ left: ['workspaces', 'explorer', 'search'], right: ['git', 'cateAgent'] })

    // Move the first icon to the end: source 0 < target 3 → insertAt 2.
    useUIStore.getState().moveSidebarView('workspaces', 'left', 3)

    expect(useSettingsStore.getState().sidebarLayout.left).toEqual(['explorer', 'search', 'workspaces'])
  })
})

describe('left sidebar visibility', () => {
  it('setLeftSidebarHidden and toggleLeftSidebar flip the hidden flag', () => {
    useUIStore.getState().setLeftSidebarHidden(true)
    expect(useUIStore.getState().leftSidebarHidden).toBe(true)
    useUIStore.getState().toggleLeftSidebar()
    expect(useUIStore.getState().leftSidebarHidden).toBe(false)
  })

  it('toggleSidebar cycles hidden → open → rail-only → open', () => {
    useSettingsStore.setState({ sidebarLayout: { left: ['workspaces', 'explorer'], right: ['git'] } } as never)

    // Hidden → reveal and open the first left view.
    useUIStore.setState({ leftSidebarHidden: true, activeLeftSidebarView: null })
    useUIStore.getState().toggleSidebar()
    expect(useUIStore.getState().leftSidebarHidden).toBe(false)
    expect(useUIStore.getState().activeLeftSidebarView).toBe('workspaces')

    // Open → collapse to rail-only.
    useUIStore.getState().toggleSidebar()
    expect(useUIStore.getState().activeLeftSidebarView).toBeNull()

    // Rail-only → open the first left view again.
    useUIStore.getState().toggleSidebar()
    expect(useUIStore.getState().activeLeftSidebarView).toBe('workspaces')
  })
})

describe('normalizeSidebarLayout — cateAgent view', () => {
  it('appends cateAgent to the right sidebar when a stored layout omits it', () => {
    const layout = normalizeSidebarLayout({ left: ['explorer'], right: ['git'] })
    expect([...layout.left, ...layout.right]).toContain('cateAgent')
    // Missing views land on the right.
    expect(layout.right).toContain('cateAgent')
  })

  it('preserves an explicit placement of cateAgent on the left', () => {
    const layout = normalizeSidebarLayout({ left: ['cateAgent', 'explorer'], right: [] })
    expect(layout.left).toContain('cateAgent')
    expect(layout.right).not.toContain('cateAgent')
  })
})
