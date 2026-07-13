// =============================================================================
// Tests for MacWindowChrome — the macOS floating window-control island.
//
// jsdom's navigator is not "Mac", so the real IS_MAC is false and the component
// would render null. We mock the platform module to force the macOS path, then
// verify: the sidebar toggle renders and calls uiStore.toggleSidebar, and it
// stays rendered in native fullscreen (only the traffic lights disappear).
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

vi.mock('../lib/platform', () => ({ IS_MAC: true }))

import MacWindowChrome from './MacWindowChrome'
import { useUIStore } from '../stores/uiStore'

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
  it('renders the sidebar toggle when windowed', () => {
    const el = render()
    expect(el.querySelector('button[aria-label="Toggle sidebar"]')).not.toBeNull()
  })

  it('toggle button calls uiStore.toggleSidebar', () => {
    const spy = vi.fn()
    act(() => { useUIStore.setState({ toggleSidebar: spy }) })
    const el = render()
    const btn = el.querySelector<HTMLButtonElement>('button[aria-label="Toggle sidebar"]')!
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('still renders the toggle in native fullscreen (lights gone, toggle stays)', () => {
    vi.mocked(window.electronAPI.isMainWindowFullscreen).mockReturnValue(true)
    const el = render()
    expect(el.querySelector('button[aria-label="Toggle sidebar"]')).not.toBeNull()
  })
})
