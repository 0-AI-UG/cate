// =============================================================================
// Regression test for the macOS traffic-light inset on the left sidebar.
//
// The left sidebar reserves MAC_CHROME_HEIGHT at its top so its content clears
// the native traffic lights. In native fullscreen macOS hides the lights, so
// that reservation must collapse — otherwise the rail/content stay pushed down
// by a 36px dead band with nothing in it.
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
  it('reserves the traffic-light strip when windowed', () => {
    expect(renderSidebar().style.paddingTop).toBe('36px')
  })

  it('collapses the reservation in native fullscreen (lights gone)', () => {
    vi.mocked(window.electronAPI.isMainWindowFullscreen).mockReturnValue(true)
    expect(renderSidebar().style.paddingTop).toBe('0px')
  })
})
