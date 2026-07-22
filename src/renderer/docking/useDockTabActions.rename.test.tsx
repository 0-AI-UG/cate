// =============================================================================
// useDockTabActions rename-seed regression: commitRename must NOT write when
// the submitted value equals the value beginRename seeded the input with.
// renamePanelByUser sets titleUserOverridden, so committing an unchanged seed
// (a live auto-title like "Agent · foo") would freeze it as a permanent user
// title the user never actually typed. Only an actual edit may rename.
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
import { useDockTabActions } from './useDockTabActions'
import { CanvasStoreProvider } from '../stores/CanvasStoreContext'
import { useAppStore } from '../stores/appStore'
import { createDockStore } from '../stores/dockStore'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../stores/canvasStore'
import type { DockTabStack } from '../../shared/types'

const STACK: DockTabStack = { type: 'tabs', id: 'stack-1', panelIds: ['p1'], activeIndex: 0 }

type Actions = ReturnType<typeof useDockTabActions>
const api: { current: Actions | null } = { current: null }

const dockStore = createDockStore()

const Harness: React.FC = () => {
  api.current = useDockTabActions({
    stack: STACK,
    zone: 'center',
    dockStoreApi: dockStore,
    workspaceId: 'ws-rename',
  })
  return null
}

let host: HTMLDivElement
let root: Root
const renamePanelByUser = vi.fn()
const initialAppState = useAppStore.getState()

beforeEach(() => {
  renamePanelByUser.mockClear()
  useAppStore.setState({ renamePanelByUser } as never)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root.render(
      <CanvasStoreProvider store={getOrCreateCanvasStoreForPanel('rename-harness-cv')}>
        <Harness />
      </CanvasStoreProvider>,
    )
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  releaseCanvasStoreForPanel('rename-harness-cv')
  useAppStore.setState(initialAppState, true)
  api.current = null
})

describe('useDockTabActions — commitRename seed regression', () => {
  it('committing the seeded value unchanged does NOT rename', () => {
    act(() => { api.current!.beginRename('p1', 'Agent · foo') })
    expect(api.current!.renameId).toBe('p1')
    expect(api.current!.renameValue).toBe('Agent · foo')

    act(() => { api.current!.commitRename('p1') })

    expect(renamePanelByUser).not.toHaveBeenCalled()
    expect(api.current!.renameId).toBeNull() // rename mode still exits
  })

  it('committing an edited value renames the panel', () => {
    act(() => { api.current!.beginRename('p1', 'Agent · foo') })
    act(() => { api.current!.setRenameValue('Build agent') })
    act(() => { api.current!.commitRename('p1') })

    expect(renamePanelByUser).toHaveBeenCalledTimes(1)
    expect(renamePanelByUser).toHaveBeenCalledWith('ws-rename', 'p1', 'Build agent')
  })

  it('a fresh beginRename re-seeds: the previous seed does not leak into the next rename', () => {
    // First rename: edit and commit.
    act(() => { api.current!.beginRename('p1', 'Agent · foo') })
    act(() => { api.current!.setRenameValue('Custom') })
    act(() => { api.current!.commitRename('p1') })
    renamePanelByUser.mockClear()

    // Second rename seeds with the NEW title; committing it unchanged is a no-op.
    act(() => { api.current!.beginRename('p1', 'Custom') })
    act(() => { api.current!.commitRename('p1') })
    expect(renamePanelByUser).not.toHaveBeenCalled()
  })
})
