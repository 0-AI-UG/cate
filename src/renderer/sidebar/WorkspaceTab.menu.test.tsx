// =============================================================================
// WorkspaceTab menus + detached rows — rendered component tests for the
// workspace overview's interactions:
//
//   • workspace context menu: dispatch per item id, the live-panels enabled
//     flag for "Close All Panels" (the workspace PROP's panels can be stale),
//     its "…in This Window" label when detached panels exist, and the
//     active-terminal-first "Copy Working Directory" (disabled with neither a
//     rootPath nor a terminal).
//   • panel-row context menu: exact items, close behind the running-terminal
//     gate, and "Move into New Window" via movePanelToNewWindow.
//   • panel-row rename seed: committing the DERIVED label unchanged must not
//     freeze it as a user title (renamePanelByUser / titleUserOverridden).
//   • "Other windows" section: nesting under detached canvases, the orphan
//     child (parentCanvasId matching no canvas in the union) rendering
//     top-level instead of being dropped, the detached-row context menu
//     (Show in Window / Close) that does NOT bubble into the workspace menu.
//   • collapsed badge counts rendered rows (ghost records excluded), not the
//     raw ws.panels registry size.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Mocks for modules that explode under jsdom (xterm) or need controllable
// panelId↔ptyId lookups for the cwd/running-terminal paths.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  ptyForPanel: new Map<string, string>(),
  wsForPty: new Map<string, string>(),
}))

vi.mock('../lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: {
    entries: () => [],
    ptyIdForPanel: (panelId: string) => h.ptyForPanel.get(panelId) ?? null,
    panelIdForPty: (ptyId: string) => {
      for (const [panelId, pty] of h.ptyForPanel) if (pty === ptyId) return panelId
      return null
    },
    workspaceIdForPty: (ptyId: string) => h.wsForPty.get(ptyId),
    dispose: vi.fn(),
    release: vi.fn(),
    disposeWorkspace: vi.fn(),
    has: () => false,
    getEntry: () => undefined,
  },
}))
vi.mock('../../cateAgent/renderer/codingSessionRegistry', () => ({
  disposeCateAgentPanel: vi.fn(),
  getCateAgentPanelSession: vi.fn(),
  saveCateAgentPanelSession: vi.fn(),
}))

import { WorkspaceTab } from './WorkspaceTab'
import { useAppStore } from '../stores/appStore'
import { useStatusStore } from '../stores/statusStore'
import { useWindowPanelStore } from '../stores/windowPanelStore'
import { releaseCanvasStoreForPanel } from '../stores/canvasStore'
import { createDockStore } from '../stores/dockStore'
import { registerWorkspaceDockStore, releaseWorkspaceDockStore } from '../lib/workspace/dockRegistry'
import { setActivePanel } from '../lib/activePanel'
import type { NativeContextMenuItem } from '../../shared/electron-api'
import type { PanelState, WindowPanelInfo, WorkspaceState } from '../../shared/types'

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const WS = 'ws-tab'

const showContextMenu = vi.fn<(items: NativeContextMenuItem[]) => Promise<string | null>>()
const confirmUnsavedChanges = vi.fn()
const confirmCloseTerminal = vi.fn()
const focusWindowPanel = vi.fn().mockResolvedValue(undefined)
const closeWindowPanel = vi.fn().mockResolvedValue(undefined)
const dragDetach = vi.fn()
const clipboardWriteText = vi.fn()

function panel(id: string, type: PanelState['type'], extra: Partial<PanelState> = {}): PanelState {
  return { id, type, title: id, isDirty: false, ...extra } as PanelState
}

function makeWorkspace(panels: PanelState[], extra: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    id: WS,
    name: 'Alpha',
    color: '',
    rootPath: '/tmp/proj',
    rootPathError: null,
    isRootPathPending: false,
    worktrees: [],
    panels: Object.fromEntries(panels.map((p) => [p.id, p])),
    ...extra,
  } as unknown as WorkspaceState
}

function seed(ws: WorkspaceState): WorkspaceState {
  useAppStore.setState({ workspaces: [ws], selectedWorkspaceId: WS } as never)
  return ws
}

function panelsOf(): Record<string, PanelState> {
  return useAppStore.getState().workspaces.find((w) => w.id === WS)?.panels ?? {}
}

function detached(panelId: string, type: WindowPanelInfo['type'], extra: Partial<WindowPanelInfo> = {}): WindowPanelInfo {
  return { panelId, type, title: panelId, workspaceId: WS, ownerWindowId: 7, ownerWindowType: 'dock', ...extra }
}

let host: HTMLDivElement
let root: Root
const initialAppState = useAppStore.getState()

async function renderTab(ws: WorkspaceState, opts: { isSelected?: boolean; isExpanded?: boolean } = {}): Promise<void> {
  await act(async () => {
    root.render(
      <WorkspaceTab
        workspace={ws}
        isSelected={opts.isSelected ?? true}
        isExpanded={opts.isExpanded ?? true}
        onToggleExpand={() => {}}
        onClick={() => {}}
      />,
    )
    // Flush WorkspaceSkillsTree's lazy manifest fetch inside act.
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** Innermost element whose exact text is `text`. */
function byText(text: string): HTMLElement {
  const all = Array.from(host.querySelectorAll<HTMLElement>('*')).filter((el) => el.textContent === text)
  const el = all[all.length - 1]
  expect(el, `element with text "${text}"`).toBeTruthy()
  return el
}

/** Right-click `el` and drain the async menu handler. */
async function rightClick(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
  })
}

function lastMenuItems(): NativeContextMenuItem[] {
  const calls = showContextMenu.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0]
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  showContextMenu.mockReset().mockResolvedValue(null)
  confirmUnsavedChanges.mockReset()
  confirmCloseTerminal.mockReset()
  focusWindowPanel.mockClear()
  closeWindowPanel.mockClear()
  dragDetach.mockReset()
  clipboardWriteText.mockClear()
  h.ptyForPanel.clear()
  h.wsForPty.clear()
  setActivePanel(null)
  useStatusStore.setState({ workspaces: {} })
  useWindowPanelStore.setState({ panels: [] })

  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    isE2E: false,
    showContextMenu,
    confirmUnsavedChanges,
    confirmCloseTerminal,
    focusWindowPanel,
    closeWindowPanel,
    dragDetach,
    openFolderDialog: vi.fn().mockResolvedValue(null),
    skillsListInstalled: vi.fn().mockResolvedValue([]),
    workspaceCreate: vi.fn(async () => ({ ok: true, workspace: {} })),
    workspaceUpdate: vi.fn(async () => ({ ok: true, workspace: {} })),
    workspaceRemove: vi.fn(async () => ({ ok: true })),
    recentProjectsAdd: vi.fn(),
    recentProjectsRemove: vi.fn(async () => undefined),
    agentDispose: vi.fn(async () => undefined),
  }
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: clipboardWriteText },
    configurable: true,
  })

  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  releaseWorkspaceDockStore(WS)
  releaseCanvasStoreForPanel('cv')
  useAppStore.setState(initialAppState, true)
})

// ---------------------------------------------------------------------------
// Workspace context menu
// ---------------------------------------------------------------------------

describe('workspace context menu', () => {
  it('does not offer the removed duplicate-workspace action', async () => {
    const ws = seed(makeWorkspace([panel('t1', 'terminal')]))
    await renderTab(ws)

    await rightClick(byText('Alpha'))

    expect(lastMenuItems().some((item) => item.id === 'duplicate')).toBe(false)
  })

  it("'select' calls selectWorkspace", async () => {
    const selectWorkspace = vi.fn()
    const ws = seed(makeWorkspace([panel('t1', 'terminal')]))
    useAppStore.setState({ selectWorkspace } as never)
    showContextMenu.mockResolvedValue('select')
    await renderTab(ws, { isSelected: false })

    await rightClick(byText('Alpha'))

    expect(selectWorkspace).toHaveBeenCalledWith(WS)
  })

  it("'rename' shows the inline input seeded with the workspace name", async () => {
    const ws = seed(makeWorkspace([panel('t1', 'terminal')]))
    showContextMenu.mockResolvedValue('rename')
    await renderTab(ws)

    expect(host.querySelector('input')).toBeNull()
    await rightClick(byText('Alpha'))

    const input = host.querySelector('input')
    expect(input).not.toBeNull()
    expect(input!.value).toBe('Alpha')
  })

  it("'color:<c>' sets the workspace color", async () => {
    const ws = seed(makeWorkspace([panel('t1', 'terminal')]))
    showContextMenu.mockResolvedValue('color:blue')
    await renderTab(ws)

    await rightClick(byText('Alpha'))

    expect(useAppStore.getState().workspaces.find((w) => w.id === WS)?.color).toBe('blue')
  })

  it("'copy-cwd' prefers the ACTIVE panel's terminal cwd over other terminals", async () => {
    const ws = seed(makeWorkspace([panel('t-active', 'terminal'), panel('t-other', 'terminal')]))
    h.ptyForPanel.set('t-active', 'pty-a')
    h.ptyForPanel.set('t-other', 'pty-b')
    useStatusStore.setState({
      workspaces: {
        [WS]: {
          terminals: {
            'pty-b': { activity: { type: 'idle' }, agentState: 'notRunning', agentName: null, agentPresent: false, listeningPorts: [], cwd: '/other' },
            'pty-a': { activity: { type: 'idle' }, agentState: 'notRunning', agentName: null, agentPresent: false, listeningPorts: [], cwd: '/active' },
          },
        },
      },
    })
    setActivePanel('t-active')
    showContextMenu.mockResolvedValue('copy-cwd')
    await renderTab(ws)

    await rightClick(byText('Alpha'))

    expect(clipboardWriteText).toHaveBeenCalledWith('/active')
  })

  it("'copy-cwd' is disabled when there is neither a rootPath nor any terminal", async () => {
    const ws = seed(makeWorkspace([], { rootPath: '' }))
    await renderTab(ws)

    // No rootPath renders the "Add Workspace" empty-state row; its context menu
    // is still the workspace menu.
    await rightClick(byText('Add Workspace'))

    const item = lastMenuItems().find((i) => i.id === 'copy-cwd')
    expect(item).toBeTruthy()
    expect(item!.enabled).toBe(false)
  })

  it("'close-panels' is enabled from the LIVE panel registry even when the workspace prop is stale", async () => {
    const ws = seed(makeWorkspace([panel('t1', 'terminal')]))
    // The prop carries a STALE panels snapshot (useWorkspaceList's equality fn
    // ignores panels) — the enabled flag must come from the live registry.
    await renderTab({ ...ws, panels: {} } as WorkspaceState)

    await rightClick(byText('Alpha'))

    const item = lastMenuItems().find((i) => i.id === 'close-panels')
    expect(item).toBeTruthy()
    expect(item!.enabled).toBe(true)
    expect(item!.label).toBe('Close All Panels')
  })

  it("'close-panels' label switches to 'in This Window' when detached panels exist", async () => {
    const ws = seed(makeWorkspace([panel('t1', 'terminal')]))
    useWindowPanelStore.setState({ panels: [detached('dt', 'terminal')] })
    await renderTab(ws)

    await rightClick(byText('Alpha'))

    const item = lastMenuItems().find((i) => i.id === 'close-panels')
    expect(item!.label).toBe('Close All Panels in This Window')
  })

  it("'close-panels' routes through the confirm gate — cancel keeps the panels", async () => {
    const ws = seed(makeWorkspace([
      panel('e1', 'editor', { isDirty: true, title: 'a.ts •', filePath: '/x/a.ts' }),
      panel('t1', 'terminal'),
    ]))
    showContextMenu.mockResolvedValue('close-panels')
    confirmUnsavedChanges.mockResolvedValue('cancel')
    await renderTab(ws)

    await rightClick(byText('Alpha'))

    expect(confirmUnsavedChanges).toHaveBeenCalledTimes(1)
    expect(panelsOf()['e1']).toBeDefined()
    expect(panelsOf()['t1']).toBeDefined()
  })

  it("'remove' routes through removeWorkspacesWithConfirm and removes the workspace", async () => {
    const ws = seed(makeWorkspace([panel('t1', 'terminal')]))
    showContextMenu.mockResolvedValue('remove')
    await renderTab(ws)

    await rightClick(byText('Alpha'))

    expect(useAppStore.getState().workspaces.map((w) => w.id)).not.toContain(WS)
  })
})

// ---------------------------------------------------------------------------
// Panel-row context menu
// ---------------------------------------------------------------------------

describe('panel-row context menu', () => {
  it('offers exactly Rename / Move into New Window / separator / Close', async () => {
    const ws = seed(makeWorkspace([panel('t1', 'terminal')]))
    await renderTab(ws)

    await rightClick(byText('t1'))

    expect(showContextMenu).toHaveBeenCalledTimes(1) // no bubbling into the workspace menu
    const items = lastMenuItems()
    expect(items).toEqual([
      { id: 'rename', label: 'Rename' },
      { id: 'move-window', label: 'Move into New Window' },
      { type: 'separator' },
      { id: 'close', label: 'Close' },
    ])
  })

  it("'close' on a running terminal routes through the confirm flow", async () => {
    const ws = seed(makeWorkspace([panel('t1', 'terminal')]))
    h.ptyForPanel.set('t1', 'pty-1')
    h.wsForPty.set('pty-1', WS)
    useStatusStore.setState({
      workspaces: {
        [WS]: {
          terminals: {
            'pty-1': { activity: { type: 'running', processName: 'vim' }, agentState: 'notRunning', agentName: null, agentPresent: false, listeningPorts: [], cwd: '' },
          },
        },
      },
    })
    showContextMenu.mockResolvedValue('close')
    await renderTab(ws)

    // Cancel → the panel survives.
    confirmCloseTerminal.mockResolvedValueOnce('cancel')
    await rightClick(byText('t1'))
    expect(confirmCloseTerminal).toHaveBeenCalledWith({ count: 1, processName: 'vim' })
    expect(panelsOf()['t1']).toBeDefined()

    // Confirm → the panel is closed.
    confirmCloseTerminal.mockResolvedValueOnce('close')
    await rightClick(byText('t1'))
    expect(panelsOf()['t1']).toBeUndefined()
  })

  it("'move-window' detaches via dragDetach and drops the record", async () => {
    const ws = seed(makeWorkspace([panel('t1', 'terminal')]))
    const dock = createDockStore()
    dock.getState().dockPanel('t1', 'center')
    registerWorkspaceDockStore(WS, dock)
    dragDetach.mockResolvedValue(3)
    showContextMenu.mockResolvedValue('move-window')
    await renderTab(ws)

    await rightClick(byText('t1'))

    expect(dragDetach).toHaveBeenCalledTimes(1)
    expect(dragDetach).toHaveBeenCalledWith(expect.anything(), WS)
    expect(panelsOf()['t1']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Panel-row rename seed regression
// ---------------------------------------------------------------------------

describe('panel-row rename seed', () => {
  it('committing the seeded DERIVED label unchanged does NOT rename', async () => {
    const renamePanelByUser = vi.fn()
    const ws = seed(makeWorkspace([panel('e1', 'editor', { title: '', filePath: '/x/notes.md' })]))
    useAppStore.setState({ renamePanelByUser } as never)
    await renderTab(ws)

    // The row label is the DERIVED file basename.
    const label = byText('notes.md')
    act(() => { label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    const input = host.querySelector('input') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.value).toBe('notes.md') // seeded with the derived label

    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })

    expect(renamePanelByUser).not.toHaveBeenCalled()
    expect(panelsOf()['e1'].title).toBe('') // no frozen user title
    expect(panelsOf()['e1'].titleUserOverridden).toBeUndefined()
    expect(host.querySelector('input')).toBeNull() // rename mode exits
  })

  it('committing an edited value DOES rename', async () => {
    const renamePanelByUser = vi.fn()
    const ws = seed(makeWorkspace([panel('e1', 'editor', { title: '', filePath: '/x/notes.md' })]))
    useAppStore.setState({ renamePanelByUser } as never)
    await renderTab(ws)

    const label = byText('notes.md')
    act(() => { label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    const input = host.querySelector('input') as HTMLInputElement
    act(() => { setInputValue(input, 'My Notes') })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })

    expect(renamePanelByUser).toHaveBeenCalledTimes(1)
    expect(renamePanelByUser).toHaveBeenCalledWith(WS, 'e1', 'My Notes')
  })
})

// ---------------------------------------------------------------------------
// "Other windows" (detached) section
// ---------------------------------------------------------------------------

describe('detached section', () => {
  function seedDetachedUnion(): WorkspaceState {
    const ws = seed(makeWorkspace([]))
    useWindowPanelStore.setState({
      panels: [
        detached('dc', 'canvas', { title: 'Canvas' }),
        detached('ct', 'terminal', { parentCanvasId: 'dc' }),
        detached('oc', 'terminal', { parentCanvasId: 'missing-canvas' }),
        detached('dt', 'browser'),
      ],
    })
    return ws
  }

  it('renders the header, nests children under their canvas, and keeps the orphan top-level', async () => {
    await renderTab(seedDetachedUnion())

    expect(host.textContent).toContain('Other windows')
    expect(host.textContent).toContain('Canvas')

    // Child of the detached canvas is nested (indent = pl-10).
    const child = byText('ct').closest('button')!
    expect(child.className).toContain('pl-10')

    // Regression: a child whose parentCanvasId matches NO canvas in the union
    // still renders — top-level (pl-7), not silently dropped.
    const orphan = byText('oc').closest('button')!
    expect(orphan.className).toContain('pl-7')

    // Plain top-level detached panel renders too.
    const top = byText('dt').closest('button')!
    expect(top.className).toContain('pl-7')
  })

  it('clicking a detached row focuses it in its owning window', async () => {
    await renderTab(seedDetachedUnion())

    act(() => { byText('dt').closest('button')!.click() })

    expect(focusWindowPanel).toHaveBeenCalledWith('dt')
  })

  it('right-click opens the detached menu (Show in Window / Close), not the workspace menu', async () => {
    await renderTab(seedDetachedUnion())
    showContextMenu.mockResolvedValue('close')

    await rightClick(byText('ct').closest('button')!)

    // Exactly one menu — the event must not bubble into the workspace handler.
    expect(showContextMenu).toHaveBeenCalledTimes(1)
    const items = lastMenuItems()
    expect(items).toEqual([
      { id: 'show', label: 'Show in Window' },
      { type: 'separator' },
      { id: 'close', label: 'Close' },
    ])
    expect(closeWindowPanel).toHaveBeenCalledWith('ct')
  })

  it("'show' focuses the panel in its owning window", async () => {
    await renderTab(seedDetachedUnion())
    showContextMenu.mockResolvedValue('show')

    await rightClick(byText('dt').closest('button')!)

    expect(focusWindowPanel).toHaveBeenCalledWith('dt')
  })
})

// ---------------------------------------------------------------------------
// Collapsed badge — ghost exclusion
// ---------------------------------------------------------------------------

describe('collapsed badge', () => {
  it('counts rendered rows (ghosts excluded), not the raw ws.panels size', async () => {
    const ws = seed(makeWorkspace([panel('cv', 'canvas'), panel('t1', 'terminal'), panel('ghost', 'terminal')]))
    // The dock store places cv + t1; `ghost` is in ws.panels but placed nowhere.
    const dock = createDockStore()
    dock.getState().dockPanel('cv', 'center')
    dock.getState().dockPanel('t1', 'center')
    registerWorkspaceDockStore(WS, dock)

    await renderTab(ws, { isExpanded: false })

    const badge = Array.from(host.querySelectorAll('span')).find((el) => el.className.includes('text-[10px]'))
    expect(badge).toBeTruthy()
    expect(badge!.textContent).toBe('2') // NOT 3 — the ghost is excluded
  })
})
