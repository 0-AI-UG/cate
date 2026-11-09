import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DiffRows } from './DiffRows'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => vi.unstubAllGlobals())

it('bounds a long diff, reveals distant rows, and retains a composing row offscreen', () => {
  const observers = new Map<Element, (entries: Array<{ isIntersecting: boolean }>) => void>()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(el: Element) { observers.set(el, this.callback) }
    disconnect() {}
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = (keep?: number) => act(() => root.render(<DiffRows count={5000} columns={100} wrap={false} keepRow={i => i === keep} renderRow={i => <div data-line={i}>Line {i}</div>} />))
  try {
    render()
    expect(host.querySelectorAll('[data-line]')).toHaveLength(40)
    const distant = host.querySelector('[data-diff-chunk="4000"]')!
    act(() => observers.get(distant)!([{ isIntersecting: true }]))
    expect(host.querySelector('[data-line="4000"]')).not.toBeNull()
    render(4000)
    act(() => observers.get(distant)!([{ isIntersecting: false }]))
    expect(host.querySelector('[data-line="4000"]')).not.toBeNull()
    render()
    expect(host.querySelector('[data-line="4000"]')).toBeNull()
    expect(host.querySelectorAll('[data-line]')).toHaveLength(40)
  } finally { act(() => root.unmount()); host.remove() }
})

it('pairs distant changed lines and keeps split and wrapped comment drafts mounted', async () => {
  const { HunkView } = await import('./ReviewDiff')
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const host = document.createElement('div')
  const root = createRoot(host)
  const hunk = {
    header: '@@ -1,250 +1,250 @@', oldStart: 1, oldLines: 250, newStart: 1, newLines: 250,
    lines: [
      ...Array.from({ length: 250 }, (_, i) => ({ kind: 'delete' as const, oldLine: i + 1, newLine: null, text: `before value ${i}` })),
      ...Array.from({ length: 250 }, (_, i) => ({ kind: 'add' as const, oldLine: null, newLine: i + 1, text: `after value ${i}` })),
    ],
  }
  const render = (split: boolean, wrap: boolean) => act(() => root.render(<HunkView hunk={hunk} split={split} wrap={wrap} wordDiff notes={[]} addNote={() => {}} toggleNote={() => {}} noteDraft={{ filePath: 'file.ts', side: 'new', line: 250, context: 'after value 249' }} submitNote={() => {}} cancelNote={() => {}} />))
  try {
    render(false, false)
    expect(host.querySelector('[aria-label="Add review note on new line 250"]')).not.toBeNull()
    expect(host.querySelectorAll('button[aria-label^="Add review note"]')).toHaveLength(60)
    expect(host.querySelector('[aria-label="Review note"]')).not.toBeNull()
    expect(host.querySelector('span.bg-current\\/15')?.textContent).toBe('before')
    render(true, true)
    expect(host.querySelector('[aria-label="Add review note on new line 250"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Review note"]')).not.toBeNull()
    expect(host.querySelectorAll('button[aria-label^="Add review note"]').length).toBeLessThan(200)
  } finally { act(() => root.unmount()); host.remove() }
})

it('releases an offscreen chunk after its protected keyboard focus leaves', async () => {
  const callbacks = new Map<Element, (entries: Array<{ isIntersecting: boolean }>) => void>()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(el: Element) { callbacks.set(el, this.callback) }
    disconnect() {}
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const host = document.createElement('div')
  const outside = document.createElement('button')
  document.body.append(host, outside)
  const root = createRoot(host)
  try {
    act(() => root.render(<DiffRows count={5000} columns={80} wrap={false} renderRow={i => <button data-line={i}>Line {i}</button>} />))
    act(() => host.querySelector<HTMLButtonElement>('[data-line="0"]')!.focus())
    const chunk = host.querySelector('[data-diff-chunk="0"]')!
    act(() => callbacks.get(chunk)!([{ isIntersecting: false }]))
    expect(host.querySelector('[data-line="0"]')).not.toBeNull()
    await act(async () => { outside.focus(); await Promise.resolve() })
    expect(host.querySelector('[data-line="0"]')).toBeNull()
  } finally { act(() => root.unmount()); host.remove(); outside.remove() }
})

it('retains every chunk in a multi-chunk selection until the selection clears', () => {
  const callbacks = new Map<Element, (entries: Array<{ isIntersecting: boolean }>) => void>()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(el: Element) { callbacks.set(el, this.callback) }
    disconnect() {}
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const selection = window.getSelection()!
  try {
    act(() => root.render(<DiffRows count={200} columns={80} wrap={false} renderRow={i => <span data-line={i}>{`Line ${i}\n`}</span>} />))
    const middle = host.querySelector('[data-diff-chunk="40"]')!
    const last = host.querySelector('[data-diff-chunk="80"]')!
    act(() => {
      callbacks.get(middle)!([{ isIntersecting: true }])
      callbacks.get(last)!([{ isIntersecting: true }])
    })
    const range = document.createRange()
    range.setStartBefore(host.querySelector('[data-line="0"]')!)
    range.setEndAfter(host.querySelector('[data-line="119"]')!)
    selection.removeAllRanges()
    selection.addRange(range)
    const selected = selection.toString()
    act(() => callbacks.get(middle)!([{ isIntersecting: false }]))
    expect(selection.toString()).toBe(selected)
    expect(host.querySelector('[data-line="40"]')).not.toBeNull()
    act(() => {
      selection.removeAllRanges()
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(host.querySelector('[data-line="40"]')).toBeNull()
  } finally { selection.removeAllRanges(); act(() => root.unmount()); host.remove() }
})
