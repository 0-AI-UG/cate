// =============================================================================
// Tests for TitlebarStrip's frameless menu bar (Windows/Linux).
//
// jsdom's navigator.userAgent is not "Mac", so the Windows/Linux branch renders
// here. Verifies the top-level application-menu labels (fetched from main) are
// drawn as buttons and that clicking one pops the matching native submenu via
// popupAppMenu(index, …).
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

import TitlebarStrip from './TitlebarStrip'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.clearAllMocks()
})

// Render and let the async getAppMenuBarItems() resolve into state.
async function render() {
  await act(async () => {
    root.render(<TitlebarStrip />)
    await Promise.resolve()
  })
  return host
}

describe('TitlebarStrip menu bar', () => {
  it('draws a button for each top-level application-menu label', async () => {
    vi.mocked(window.electronAPI.getAppMenuBarItems).mockResolvedValue(['Cate', 'File', 'Edit', 'Help'])
    const el = await render()
    const labels = Array.from(el.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toEqual(expect.arrayContaining(['Cate', 'File', 'Edit', 'Help']))
  })

  it('pops the matching native submenu by index on click', async () => {
    vi.mocked(window.electronAPI.getAppMenuBarItems).mockResolvedValue(['Cate', 'File', 'Help'])
    const el = await render()
    const fileBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'File')!
    act(() => { fileBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(window.electronAPI.popupAppMenu).toHaveBeenCalledTimes(1)
    // 'File' is index 1; coordinates come from getBoundingClientRect.
    expect(window.electronAPI.popupAppMenu).toHaveBeenCalledWith(1, expect.any(Number), expect.any(Number))
  })

  it('renders no menu buttons when main returns no labels', async () => {
    vi.mocked(window.electronAPI.getAppMenuBarItems).mockResolvedValue([])
    const el = await render()
    // Only the window controls (Minimize/Maximize/Close) should be present.
    const labels = Array.from(el.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual(expect.arrayContaining(['Minimize', 'Maximize', 'Close']))
    expect(el.textContent).toBe('')
  })
})
