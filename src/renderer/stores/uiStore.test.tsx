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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

import { useSidebarLayout, normalizeSidebarLayout } from './uiStore'
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
