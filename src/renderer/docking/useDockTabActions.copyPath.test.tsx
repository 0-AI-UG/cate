// =============================================================================
// useDockTabActions tab menu — Copy Path / Copy Relative Path. The pair mirrors
// the file explorer's items and is gated on panel.filePath: a scratch editor
// has no file yet, so offering the items there would copy nothing. Relative
// resolves against the workspace rootPath, falling back to the absolute host
// path; remote locators copy the host path, not the cate-runtime:// URI.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: { entries: () => [], panelIdForPty: () => null, ptyIdForPanel: () => null, has: () => false, getEntry: () => undefined, dispose: vi.fn(), release: vi.fn(), disposeWorkspace: vi.fn(), resetRendering: vi.fn() },
}))
import { useDockTabActions } from './useDockTabActions'
import { CanvasStoreProvider } from '../stores/CanvasStoreContext'
import { useAppStore } from '../stores/appStore'
import { createDockStore } from '../stores/dockStore'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../stores/canvasStore'
import type { NativeContextMenuItem } from '../../shared/electron-api'
import type { DockTabStack, PanelState } from '../../shared/types'

const WS = 'ws-copy-path'
const STACK: DockTabStack = { type: 'tabs', id: 'stack-1', panelIds: ['p1'], activeIndex: 0 }

const EDITOR_PANEL = { id: 'p1', type: 'editor', title: 'a.md', isDirty: false, filePath: '/root/sub/a.md' } as PanelState
const SCRATCH_PANEL = { id: 'p1', type: 'editor', title: 'Untitled', isDirty: false, unsavedContent: 'draft' } as PanelState
const REMOTE_PANEL = { id: 'p1', type: 'editor', title: 'a.ts', isDirty: false, filePath: 'cate-runtime://srv_1/home/u/proj/a.ts' } as PanelState
const WORKTREE_PANEL = {
  id: 'p1', type: 'editor', title: 'feature.ts', isDirty: false,
  filePath: '/root/.cate/worktrees/feature/src/feature.ts', worktreeId: 'wt-feature',
} as PanelState

type Actions = ReturnType<typeof useDockTabActions>
const api: { current: Actions | null } = { current: null }

const dockStore = createDockStore()
const showContextMenu = vi.fn<(items: NativeContextMenuItem[]) => Promise<string | null>>()
const clipboardWriteText = vi.fn()

// getPanelProp reads the fixture at call time, so a test can swap which panel
// the single tab stands for before it opens the menu — no re-render needed.
let panelFixture: PanelState = EDITOR_PANEL

const Harness: React.FC = () => {
  api.current = useDockTabActions({
    stack: STACK,
    zone: 'center',
    dockStoreApi: dockStore,
    workspaceId: WS,
    getPanelProp: () => panelFixture,
  })
  return null
}

let host: HTMLDivElement
let root: Root
const initialAppState = useAppStore.getState()
const originalClipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')

async function openTabMenu(): Promise<void> {
  await act(async () => {
    await api.current!.handleTabContextMenu({
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as never, 'p1')
  })
}

function lastMenuItems(): NativeContextMenuItem[] {
  const calls = showContextMenu.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0]
}

beforeEach(() => {
  panelFixture = EDITOR_PANEL
  showContextMenu.mockReset().mockResolvedValue(null)
  clipboardWriteText.mockClear()
  useAppStore.setState({
    workspaces: [{ id: WS, rootPath: '/root', panels: {} }],
    selectedWorkspaceId: WS,
  } as never)
  Object.defineProperty(window.electronAPI, 'showContextMenu', {
    configurable: true,
    value: showContextMenu,
  })
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: clipboardWriteText },
    configurable: true,
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root.render(
      <CanvasStoreProvider store={getOrCreateCanvasStoreForPanel('copy-path-harness-cv')}>
        <Harness />
      </CanvasStoreProvider>,
    )
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  releaseCanvasStoreForPanel('copy-path-harness-cv')
  useAppStore.setState(initialAppState, true)
  if (originalClipboard) Object.defineProperty(window.navigator, 'clipboard', originalClipboard)
  else delete (window.navigator as { clipboard?: unknown }).clipboard
  api.current = null
})

describe('useDockTabActions — Copy Path / Copy Relative Path', () => {
  it('offers both items for a file-backed tab and copies the absolute path', async () => {
    showContextMenu.mockResolvedValue('copy-path')

    await openTabMenu()

    const items = lastMenuItems()
    expect(items).toContainEqual({ id: 'copy-path', label: 'Copy Path' })
    expect(items).toContainEqual({ id: 'copy-rel-path', label: 'Copy Relative Path' })
    expect(clipboardWriteText).toHaveBeenCalledWith('/root/sub/a.md')
  })

  it('copies the workspace-relative path when the workspace has a rootPath', async () => {
    showContextMenu.mockResolvedValue('copy-rel-path')

    await openTabMenu()

    expect(clipboardWriteText).toHaveBeenCalledWith('sub/a.md')
  })

  it('copies a worktree-backed file relative to its checkout root', async () => {
    panelFixture = WORKTREE_PANEL
    useAppStore.setState({
      workspaces: [{
        id: WS,
        rootPath: '/root',
        worktrees: [{ id: 'wt-feature', path: '/root/.cate/worktrees/feature', color: '#123456' }],
        panels: {},
      }],
      selectedWorkspaceId: WS,
    } as never)
    showContextMenu.mockResolvedValue('copy-rel-path')

    await openTabMenu()

    expect(clipboardWriteText).toHaveBeenCalledWith('src/feature.ts')
  })

  it('copies the host path, not the locator URI, for a remote file', async () => {
    panelFixture = REMOTE_PANEL
    showContextMenu.mockResolvedValue('copy-path')

    await openTabMenu()

    expect(clipboardWriteText).toHaveBeenCalledWith('/home/u/proj/a.ts')
  })

  it('falls back to the absolute path for Copy Relative Path when the workspace has no rootPath', async () => {
    useAppStore.setState({
      workspaces: [{ id: WS, rootPath: '', panels: {} }],
      selectedWorkspaceId: WS,
    } as never)
    showContextMenu.mockResolvedValue('copy-rel-path')

    await openTabMenu()

    expect(clipboardWriteText).toHaveBeenCalledWith('/root/sub/a.md')
  })

  it('omits both items for a scratch editor with no filePath', async () => {
    panelFixture = SCRATCH_PANEL

    await openTabMenu()

    const ids = lastMenuItems().map((item) => item.id)
    expect(ids).not.toContain('copy-path')
    expect(ids).not.toContain('copy-rel-path')
  })
})
