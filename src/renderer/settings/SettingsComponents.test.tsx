// =============================================================================
// Rendering tests for the settings search-filtering primitives.
//
// SettingRow and SearchableBlock self-hide based on SettingsSearchContext:
//   - no active query           → always visible
//   - query matches label/desc  → visible
//   - query matches nothing     → hidden (returns null)
//   - section title matched     → visible regardless of the query
// Visible rows/blocks carry a `data-srow` marker, which the SettingsWindow
// match-scan relies on to decide whether a section still has content.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { SettingRow, SearchableBlock } from './SettingsComponents'
import { SettingsSearchContext, type SettingsSearchState } from './SettingsSearchContext'

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

function render(search: SettingsSearchState, ui: React.ReactNode): HTMLDivElement {
  act(() => {
    root.render(
      <SettingsSearchContext.Provider value={search}>{ui}</SettingsSearchContext.Provider>,
    )
  })
  return host
}

const settingRow = (
  <SettingRow label="Editor font size" description="Monaco editor font size in px">
    <button>control</button>
  </SettingRow>
)

const isVisible = (el: HTMLElement) => el.querySelector('[data-srow]') !== null

describe('SettingRow filtering', () => {
  it('renders (with a data-srow marker) when there is no active query', () => {
    const el = render({ query: '', sectionMatched: false }, settingRow)
    expect(isVisible(el)).toBe(true)
    expect(el.textContent).toContain('Editor font size')
  })

  it('renders when the query matches the label', () => {
    const el = render({ query: 'font', sectionMatched: false }, settingRow)
    expect(isVisible(el)).toBe(true)
  })

  it('renders when the query matches the description', () => {
    const el = render({ query: 'monaco', sectionMatched: false }, settingRow)
    expect(isVisible(el)).toBe(true)
  })

  it('hides (renders nothing) when the query matches neither label nor description', () => {
    const el = render({ query: 'terminal', sectionMatched: false }, settingRow)
    expect(isVisible(el)).toBe(false)
    expect(el.textContent).toBe('')
  })

  it('stays visible when the enclosing section title matched, even on a non-matching query', () => {
    const el = render({ query: 'terminal', sectionMatched: true }, settingRow)
    expect(isVisible(el)).toBe(true)
  })
})

describe('SearchableBlock filtering', () => {
  const block = (
    <SearchableBlock keywords="theme appearance color">
      <span>theme catalog</span>
    </SearchableBlock>
  )

  it('renders its children when there is no active query', () => {
    const el = render({ query: '', sectionMatched: false }, block)
    expect(isVisible(el)).toBe(true)
    expect(el.textContent).toContain('theme catalog')
  })

  it('renders when the query matches a keyword', () => {
    const el = render({ query: 'color', sectionMatched: false }, block)
    expect(isVisible(el)).toBe(true)
  })

  it('hides when the query matches no keyword and the section title did not match', () => {
    const el = render({ query: 'font', sectionMatched: false }, block)
    expect(isVisible(el)).toBe(false)
    expect(el.textContent).toBe('')
  })

  it('stays visible when the section title matched', () => {
    const el = render({ query: 'font', sectionMatched: true }, block)
    expect(isVisible(el)).toBe(true)
  })
})
