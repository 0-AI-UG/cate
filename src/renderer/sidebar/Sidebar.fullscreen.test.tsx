// =============================================================================
// Regression test for the macOS traffic-light inset on the left sidebar.
//
// The left header shares its row with the native traffic lights. In windowed
// mode its controls shift right; fullscreen reclaims that horizontal space.
//
// jsdom's navigator is not "Mac", so IS_MAC is mocked true to force the path.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

vi.mock('../lib/platform', () => ({ IS_MAC: true }))

import { Sidebar } from './Sidebar'

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
})

function renderSidebar(): HTMLElement {
  act(() => { root.render(<Sidebar />) })
  return host.querySelector<HTMLElement>('[data-sidebar-scrollarea]')!
}

describe('Sidebar macOS chrome inset', () => {
  it('keeps the header on the first row when windowed', () => {
    const sidebar = renderSidebar()
    expect(sidebar.style.paddingTop).toBe('')
    expect(sidebar.querySelector<HTMLElement>('[aria-label="Hide sidebar"]')?.parentElement?.style.marginLeft).toBe('66px')
  })

  it('reclaims the traffic-light space in native fullscreen', () => {
    vi.mocked(window.electronAPI.isMainWindowFullscreen).mockReturnValue(true)
    expect(renderSidebar().querySelector<HTMLElement>('[aria-label="Hide sidebar"]')?.parentElement?.style.marginLeft).toBe('0px')
  })
})
