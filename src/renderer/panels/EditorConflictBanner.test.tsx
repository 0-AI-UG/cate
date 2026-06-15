// =============================================================================
// Tests for EditorConflictBanner — the non-blocking strip shown when an open
// file diverges from disk (changed by an external tool, or deleted).
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

import EditorConflictBanner from './EditorConflictBanner'

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

function buttonByText(label: string): HTMLButtonElement {
  const btn = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  )
  if (!btn) throw new Error(`button "${label}" not found; have: ${Array.from(host.querySelectorAll('button')).map((b) => b.textContent).join(', ')}`)
  return btn as HTMLButtonElement
}

describe('EditorConflictBanner — changed', () => {
  it('renders Reload, Keep mine, Keep both and View diff and wires their handlers', () => {
    const onReload = vi.fn()
    const onKeepMine = vi.fn()
    const onKeepBoth = vi.fn()
    const onViewDiff = vi.fn()
    act(() => {
      root.render(
        <EditorConflictBanner
          kind="changed"
          showDiff={false}
          onReload={onReload}
          onKeepMine={onKeepMine}
          onKeepBoth={onKeepBoth}
          onViewDiff={onViewDiff}
          onCloseDiff={vi.fn()}
          onSaveToRestore={vi.fn()}
          onDismiss={vi.fn()}
        />,
      )
    })

    act(() => { buttonByText('Reload').click() })
    act(() => { buttonByText('Keep mine').click() })
    act(() => { buttonByText('Keep both').click() })
    act(() => { buttonByText('View diff').click() })

    expect(onReload).toHaveBeenCalledTimes(1)
    expect(onKeepMine).toHaveBeenCalledTimes(1)
    expect(onKeepBoth).toHaveBeenCalledTimes(1)
    expect(onViewDiff).toHaveBeenCalledTimes(1)
  })

  it('swaps View diff for Close diff while the diff overlay is open', () => {
    const onViewDiff = vi.fn()
    const onCloseDiff = vi.fn()
    act(() => {
      root.render(
        <EditorConflictBanner
          kind="changed"
          showDiff={true}
          onReload={vi.fn()}
          onKeepMine={vi.fn()}
          onKeepBoth={vi.fn()}
          onViewDiff={onViewDiff}
          onCloseDiff={onCloseDiff}
          onSaveToRestore={vi.fn()}
          onDismiss={vi.fn()}
        />,
      )
    })

    expect(
      Array.from(host.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'View diff'),
    ).toBe(false)

    act(() => { buttonByText('Close diff').click() })

    expect(onCloseDiff).toHaveBeenCalledTimes(1)
    expect(onViewDiff).not.toHaveBeenCalled()
  })
})

describe('EditorConflictBanner — deleted', () => {
  it('renders Save to restore + Dismiss and not the change actions', () => {
    const onSaveToRestore = vi.fn()
    const onDismiss = vi.fn()
    act(() => {
      root.render(
        <EditorConflictBanner
          kind="deleted"
          showDiff={false}
          onReload={vi.fn()}
          onKeepMine={vi.fn()}
          onKeepBoth={vi.fn()}
          onViewDiff={vi.fn()}
          onCloseDiff={vi.fn()}
          onSaveToRestore={onSaveToRestore}
          onDismiss={onDismiss}
        />,
      )
    })

    expect(
      Array.from(host.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Reload'),
    ).toBe(false)

    act(() => { buttonByText('Save to restore').click() })
    act(() => { buttonByText('Dismiss').click() })

    expect(onSaveToRestore).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
