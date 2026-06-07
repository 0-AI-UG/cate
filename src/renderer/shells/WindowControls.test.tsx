// =============================================================================
// Tests for WindowControls — the custom min/max/close buttons used by the
// frameless Windows/Linux window chrome.
//
// jsdom's navigator.userAgent is not "Mac", so the component renders here (on
// macOS it returns null and these buttons never mount). Verifies each button
// calls the matching electronAPI method and that the maximize/restore label
// swaps when an onWindowMaximizeChange callback fires.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

import WindowControls from './WindowControls'

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
})

function render() {
  act(() => { root.render(<WindowControls />) })
  return host
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const btn = el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!btn) throw new Error(`button "${label}" not found`)
  return btn
}

function click(btn: HTMLButtonElement) {
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('WindowControls', () => {
  it('renders the three controls on non-mac', () => {
    const el = render()
    expect(el.querySelector('button[aria-label="Minimize"]')).not.toBeNull()
    expect(el.querySelector('button[aria-label="Maximize"]')).not.toBeNull()
    expect(el.querySelector('button[aria-label="Close"]')).not.toBeNull()
  })

  it('minimize button calls windowMinimize', () => {
    const el = render()
    click(button(el, 'Minimize'))
    expect(window.electronAPI.windowMinimize).toHaveBeenCalledTimes(1)
  })

  it('maximize button calls windowToggleMaximize', () => {
    const el = render()
    click(button(el, 'Maximize'))
    expect(window.electronAPI.windowToggleMaximize).toHaveBeenCalledTimes(1)
  })

  it('close button calls windowClose', () => {
    const el = render()
    click(button(el, 'Close'))
    expect(window.electronAPI.windowClose).toHaveBeenCalledTimes(1)
  })

  it('seeds maximized state from isWindowMaximized', () => {
    vi.mocked(window.electronAPI.isWindowMaximized).mockReturnValue(true)
    const el = render()
    // When maximized the control offers Restore instead of Maximize.
    expect(el.querySelector('button[aria-label="Restore"]')).not.toBeNull()
    expect(el.querySelector('button[aria-label="Maximize"]')).toBeNull()
  })

  it('swaps Maximize↔Restore when onWindowMaximizeChange fires', () => {
    let push: ((v: boolean) => void) | undefined
    vi.mocked(window.electronAPI.onWindowMaximizeChange).mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    const el = render()
    expect(button(el, 'Maximize')).toBeTruthy()

    act(() => { push?.(true) })
    expect(el.querySelector('button[aria-label="Restore"]')).not.toBeNull()

    act(() => { push?.(false) })
    expect(el.querySelector('button[aria-label="Maximize"]')).not.toBeNull()
  })
})
