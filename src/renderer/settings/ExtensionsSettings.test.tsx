// =============================================================================
// Catalog browsing: category filter, search, and pagination. The catalog can
// hold far more entries than fit on screen, so these three are what makes it
// navigable — a regression here silently hides extensions from users.
// =============================================================================

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useExtensionsStore } from '../stores/extensionsStore'
import type { ExtensionCategory, ExtensionListEntry } from '../../shared/extensions'
import { ExtensionsSettings } from './ExtensionsSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function entry(name: string, category?: ExtensionCategory, description = ''): ExtensionListEntry {
  return {
    manifest: { id: `acme.${name.toLowerCase()}`, name, category, panels: [{ id: 'main', label: name }] },
    enabled: false,
    source: 'catalog',
    rootDir: '',
    installed: false,
    description,
  }
}

/** Visible catalog row names, in order. */
function rowNames(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('.border-subtle > div > div > span:first-of-type')).map(
    (el) => el.textContent ?? '',
  )
}

/** A button by its text, whitespace-insensitive (chips render label+count with
 *  no separating text node, so "Design 1" and "Design1" are the same button). */
function button(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  const want = text.replace(/\s+/g, '')
  return Array.from(host.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').replace(/\s+/g, '') === want,
  )
}

describe('ExtensionsSettings — catalog browsing', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        extensionList: vi.fn(async () => []),
        extensionCatalogSources: vi.fn(async () => ['https://example.com/catalog.json']),
        onExtensionsChanged: vi.fn(),
      },
    })
    // 12 AI entries (two pages) plus one design entry to filter down to.
    const entries = [
      ...Array.from({ length: 12 }, (_, i) => entry(`Ai${String(i + 1).padStart(2, '0')}`, 'ai')),
      entry('Sketch', 'design', 'a whiteboard'),
    ]
    useExtensionsStore.setState({ entries, refresh: async () => {} })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root.render(<ExtensionsSettings />))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useExtensionsStore.setState({ entries: [] })
  })

  it('shows at most one page of rows and pages through the rest', () => {
    expect(rowNames(host)).toHaveLength(10)
    expect(rowNames(host)[0]).toBe('Ai01')

    act(() => button(host, '2')?.click())
    // 13 entries, 10 per page -> 3 on the last page.
    expect(rowNames(host)).toEqual(['Ai11', 'Ai12', 'Sketch'])
  })

  it('filters by category and drops the pager when one page is left', () => {
    act(() => button(host, 'Design 1')?.click())
    expect(rowNames(host)).toEqual(['Sketch'])
    expect(button(host, '2')).toBeUndefined()

    act(() => button(host, 'All 13')?.click())
    expect(rowNames(host)).toHaveLength(10)
  })

  it('searches name and description, and resets to the first page', () => {
    act(() => button(host, '2')?.click())
    const input = host.querySelector<HTMLInputElement>('input[placeholder="Search extensions…"]')!

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'whiteboard')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(rowNames(host)).toEqual(['Sketch'])
  })

  it('files an uncategorised extension under Other', () => {
    act(() => useExtensionsStore.setState({ entries: [entry('Loose')] }))
    act(() => button(host, 'Other 1')?.click())
    expect(rowNames(host)).toEqual(['Loose'])
  })
})
