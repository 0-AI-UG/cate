// =============================================================================
// E2E rendering tests for terminal panel agent state indicators.
//
// These test what the user actually SEES: the shimmer CSS class
// (cate-notif-pulse) and the await indicator element (cate-await-indicator).
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

// Mock modules that explode under jsdom
vi.mock('../lib/terminalRegistry', () => ({
  terminalRegistry: { entries: () => [], panelIdForPty: () => null },
}))
vi.mock('../lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { TerminalPanelRow, type PanelRenameProps } from './WorkspaceTab'
import type { AgentState } from '../../shared/types'

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

function renderRow(agentState: AgentState | undefined) {
  act(() => {
    root.render(
      <TerminalPanelRow
        panel={{ id: 'p1', type: 'terminal', title: 'Terminal 1' }}
        indent={false}
        agentState={agentState}
        hasPorts={false}
        onClick={() => {}}
      />,
    )
  })
  return host
}

function hasShimmer(el: HTMLElement): boolean {
  return el.querySelector('.cate-notif-pulse') !== null
}

function hasAwaitIndicator(el: HTMLElement): boolean {
  return el.querySelector('.cate-await-indicator') !== null
}

describe('TerminalPanelRow rendered indicators', () => {
  it('no agent state → no shimmer, no await', () => {
    const el = renderRow(undefined)
    expect(hasShimmer(el)).toBe(false)
    expect(hasAwaitIndicator(el)).toBe(false)
  })

  it('notRunning → no shimmer, no await', () => {
    const el = renderRow('notRunning')
    expect(hasShimmer(el)).toBe(false)
    expect(hasAwaitIndicator(el)).toBe(false)
  })

  it('running → shimmer visible, no await', () => {
    const el = renderRow('running')
    expect(hasShimmer(el)).toBe(true)
    expect(hasAwaitIndicator(el)).toBe(false)
  })

  it('waitingForInput → await visible, no shimmer', () => {
    const el = renderRow('waitingForInput')
    expect(hasShimmer(el)).toBe(false)
    expect(hasAwaitIndicator(el)).toBe(true)
  })

  it('finished → no shimmer, no await', () => {
    const el = renderRow('finished')
    expect(hasShimmer(el)).toBe(false)
    expect(hasAwaitIndicator(el)).toBe(false)
  })
})

// =============================================================================
// Per-panel rename: a panel row renames the SPECIFIC tab (renamePanelByUser),
// not the whole workspace. These tests exercise the TerminalPanelRow rename
// wiring — double-click begins rename, right-click opens a panel context menu
// (without bubbling to the workspace handler), and the inline input commits.
// =============================================================================

function makeRename(overrides: Partial<PanelRenameProps> = {}): PanelRenameProps {
  return {
    renameValue: null,
    onRenameChange: vi.fn(),
    onRenameSubmit: vi.fn(),
    onRenameCancel: vi.fn(),
    onBeginRename: vi.fn(),
    onContextMenu: vi.fn(),
    ...overrides,
  }
}

function renderRenameRow(rename: PanelRenameProps) {
  act(() => {
    root.render(
      <TerminalPanelRow
        panel={{ id: 'p1', type: 'terminal', title: 'Terminal 1' }}
        indent={false}
        agentState={undefined}
        hasPorts={false}
        onClick={() => {}}
        rename={rename}
      />,
    )
  })
  return host
}

describe('panel-row rename wiring', () => {
  it('double-click on the label begins a panel rename', () => {
    const rename = makeRename()
    const el = renderRenameRow(rename)
    const label = el.querySelector('span.flex-1') as HTMLElement
    expect(label.textContent).toBe('Terminal 1')
    act(() => {
      label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(rename.onBeginRename).toHaveBeenCalledTimes(1)
  })

  it('right-click routes to the panel context menu handler', () => {
    const rename = makeRename()
    const el = renderRenameRow(rename)
    const button = el.querySelector('button') as HTMLElement
    act(() => {
      button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    expect(rename.onContextMenu).toHaveBeenCalledTimes(1)
  })

  it('renders the inline input when renaming and commits on Enter', () => {
    const rename = makeRename({ renameValue: 'Terminal 1' })
    const el = renderRenameRow(rename)
    const input = el.querySelector('input') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.value).toBe('Terminal 1')
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(rename.onRenameSubmit).toHaveBeenCalledTimes(1)
    expect(rename.onRenameCancel).not.toHaveBeenCalled()
  })

  it('Escape cancels the inline rename', () => {
    const rename = makeRename({ renameValue: 'Terminal 1' })
    const el = renderRenameRow(rename)
    const input = el.querySelector('input') as HTMLInputElement
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(rename.onRenameCancel).toHaveBeenCalledTimes(1)
    expect(rename.onRenameSubmit).not.toHaveBeenCalled()
  })
})

describe('state transitions render correctly', () => {
  it('full lifecycle: each re-render shows the right indicator', () => {
    const sequence: Array<{ state: AgentState | undefined; expectShimmer: boolean; expectAwait: boolean }> = [
      { state: undefined, expectShimmer: false, expectAwait: false },
      { state: 'waitingForInput', expectShimmer: false, expectAwait: true },
      { state: 'running', expectShimmer: true, expectAwait: false },
      { state: 'waitingForInput', expectShimmer: false, expectAwait: true },
      { state: 'running', expectShimmer: true, expectAwait: false },
      { state: 'finished', expectShimmer: false, expectAwait: false },
    ]

    for (const { state, expectShimmer, expectAwait } of sequence) {
      const el = renderRow(state)
      expect(hasShimmer(el)).toBe(expectShimmer)
      expect(hasAwaitIndicator(el)).toBe(expectAwait)
    }
  })
})
