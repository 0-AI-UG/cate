// @vitest-environment jsdom
// =============================================================================
// focusedDockPlacement — routes keyboard-created panels to the surface the user
// is actually focused on (a dock zone), or the canvas by default.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { focusedDockPlacement } from './focusedDockPlacement'

/** Build a focusable leaf inside the given ancestor chain and focus it.
 *  Each entry is [tag, attrs]; the last becomes the focused element. */
function focusInside(...layers: Array<[string, Record<string, string>]>): void {
  let parent: HTMLElement = document.body
  let leaf: HTMLElement | null = null
  for (const [tag, attrs] of layers) {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    parent.appendChild(el)
    parent = el
    leaf = el
  }
  // A tabindex makes an arbitrary element focusable in jsdom.
  leaf!.setAttribute('tabindex', '-1')
  leaf!.focus()
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('focusedDockPlacement', () => {
  it('routes to the dock zone when focus is inside a docked panel', () => {
    focusInside(['div', { 'data-dock-zone': 'bottom' }], ['textarea', {}])
    expect(focusedDockPlacement()).toEqual({ target: 'dock', zone: 'bottom' })
  })

  it('routes to the center zone for a non-canvas tab beside the canvas', () => {
    focusInside(['div', { 'data-dock-zone': 'center' }], ['div', { 'data-panel-content': '' }], ['input', {}])
    expect(focusedDockPlacement()).toEqual({ target: 'dock', zone: 'center' })
  })

  it('returns undefined (canvas default) when focus is on a canvas, even though it sits inside the center zone', () => {
    // Canvas container nested in the center dock zone, focus on a canvas node:
    // the nearest surface is the canvas, so it must win over the zone.
    focusInside(
      ['div', { 'data-dock-zone': 'center' }],
      ['div', { 'data-canvas-container': '', 'data-canvas-panel-id': 'c1' }],
      ['div', { 'data-node-id': 'n1' }],
      ['textarea', {}],
    )
    expect(focusedDockPlacement()).toBeUndefined()
  })

  it('returns undefined when focus is outside any panel surface (e.g. the sidebar)', () => {
    focusInside(['div', { 'data-sidebar-keynav': '' }], ['button', {}])
    expect(focusedDockPlacement()).toBeUndefined()
  })

  it('returns undefined when nothing is focused', () => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(focusedDockPlacement()).toBeUndefined()
  })
})
