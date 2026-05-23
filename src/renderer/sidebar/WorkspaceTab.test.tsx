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

import { TerminalPanelRow } from './WorkspaceTab'
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
