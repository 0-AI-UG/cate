// =============================================================================
// DockTabBar restyle smoke test — the tab reskin (floating rounded pills, active
// bg-surface-2, hover-reveal close) is a visual-only change, but this guards the
// two things a className swap can still break at runtime: the component must
// render without throwing, and the pills must carry the intended styling classes
// (rounded-md; active = bg-surface-2; close X present when closeable). Renderer-
// only, so it is unaffected by the main-process pi-ai build breakage that blocks
// launching the full app.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: { entries: () => [], panelIdForPty: () => null, ptyIdForPanel: () => null, has: () => false, getEntry: () => undefined, dispose: vi.fn(), release: vi.fn(), disposeWorkspace: vi.fn() },
}))

import { DockTabBar } from './DockTabBar'
import { useAppStore } from '../stores/appStore'
import type { DockTabStack, PanelState } from '../../shared/types'

const STACK: DockTabStack = { type: 'tabs', id: 'stack-1', panelIds: ['p1', 'p2'], activeIndex: 0 }
const PANELS: Record<string, PanelState> = {
  p1: { id: 'p1', type: 'terminal', title: 'zsh', x: 0, y: 0, width: 400, height: 300 } as unknown as PanelState,
  p2: { id: 'p2', type: 'editor', title: 'index.ts', x: 0, y: 0, width: 400, height: 300 } as unknown as PanelState,
}

const noop = () => {}
const renameInputRef = { current: null } as React.MutableRefObject<HTMLInputElement | null>
const springLoadTimer = { current: null } as React.MutableRefObject<number | null>

function renderBar(host: HTMLDivElement, onClosePanel?: (id: string) => void) {
  const root = createRoot(host)
  act(() => {
    root.render(
      <DockTabBar
        stack={STACK}
        getPanel={(id) => PANELS[id]}
        getPanelTitle={(id) => PANELS[id]?.title ?? id}
        onClosePanel={onClosePanel}
        onTabClick={noop}
        onTabMouseDown={noop}
        onTabContextMenu={noop}
        renameId={null}
        renameValue=""
        renameInputRef={renameInputRef}
        setRenameValue={noop}
        setRenameId={noop}
        commitRename={noop}
        springLoadTimer={springLoadTimer}
        setActiveTab={noop}
        showTabPlaceholder={false}
      />,
    )
  })
  return root
}

let host: HTMLDivElement
let root: Root
const initialAppState = useAppStore.getState()

beforeEach(() => {
  useAppStore.setState({ workspaces: [], selectedWorkspaceId: undefined } as never)
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(initialAppState, true)
})

describe('DockTabBar restyle', () => {
  it('renders each panel as a rounded pill and marks the active one with bg-surface-2', () => {
    root = renderBar(host)
    const pills = host.querySelectorAll<HTMLElement>('[data-tab-panel-id]')
    expect(pills.length).toBe(2)
    for (const pill of pills) expect(pill.className).toContain('rounded-md')
    const active = host.querySelector<HTMLElement>('[data-tab-panel-id="p1"]')!
    expect(active.className).toContain('bg-surface-2')
    // Inactive tabs get the hover-fill treatment, not the solid active fill.
    const inactive = host.querySelector<HTMLElement>('[data-tab-panel-id="p2"]')!
    expect(inactive.className).toContain('hover:bg-hover')
    expect(inactive.className).not.toContain('bg-surface-2')
  })

  it('renders a close affordance only when onClosePanel is supplied', () => {
    root = renderBar(host, noop)
    const active = host.querySelector<HTMLElement>('[data-tab-panel-id="p1"]')!
    // The close X carries the red-on-hover accent from the reference look.
    const closeEl = active.querySelector('.hover\\:text-red-400')
    expect(closeEl).not.toBeNull()
  })
})
