// =============================================================================
// Tests for MacWindowChrome — the macOS floating window-control island.
//
// jsdom's navigator is not "Mac", so the real IS_MAC is false and the component
// would render null. We mock the platform module to force the macOS path, then
// verify the draggable lights strip renders when windowed (and collapses away in
// fullscreen) and that the old sidebar toggle is gone (it now lives in the rail
// / MainWindowShell).
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

vi.mock('../lib/platform', () => ({ IS_MAC: true }))

import MacWindowChrome, { TRAFFIC_LIGHTS_WIDTH } from './MacWindowChrome'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.mocked(window.electronAPI.isMainWindowFullscreen).mockReturnValue(false)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.restoreAllMocks()
})

function render() {
  act(() => { root.render(<MacWindowChrome />) })
  return host
}

describe('MacWindowChrome', () => {
  it('renders a draggable lights strip when windowed', () => {
    const el = render()
    const island = el.querySelector<HTMLElement>('div')
    expect(island).not.toBeNull()
    expect(island!.style.width).toBe(`${TRAFFIC_LIGHTS_WIDTH}px`)
  })

  it('no longer renders a sidebar toggle button (moved to the rail)', () => {
    const el = render()
    expect(el.querySelector('button[aria-label="Toggle sidebar"]')).toBeNull()
    expect(el.querySelector('button')).toBeNull()
  })

  // The lights are gone in fullscreen and a fullscreen window can't be dragged,
  // so the island has nothing left to do — and the left rail's collapse toggle
  // moves into this corner, which a leftover drag strip would sit on top of.
  it('renders nothing in native fullscreen (lights gone)', () => {
    vi.mocked(window.electronAPI.isMainWindowFullscreen).mockReturnValue(true)
    expect(render().querySelector('div')).toBeNull()
  })
})
