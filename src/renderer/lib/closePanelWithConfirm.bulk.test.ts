// =============================================================================
// Bulk close/remove confirmation — regression tests for the two canonical
// helpers in closePanelWithConfirm.ts:
//
//   • closeAllPanelsWithConfirm runs the dirty-editor + running-terminal gates
//     over ALL of a workspace's panels before appStore.closeAllPanels — a
//     cancel must close nothing.
//   • removeWorkspacesWithConfirm aggregates panels across EVERY listed
//     workspace and runs each gate ONCE (one dialog for the whole batch), then
//     removes the workspaces — previously "Close Workspace" tore panels down
//     unconditionally, skipping the gates entirely.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PanelState, WorkspaceState } from '../../shared/types'

// ---------------------------------------------------------------------------
// Hoisted fakes (vi.mock factories run before imports). The terminal registry
// fake exposes the panelId→ptyId→workspaceId lookups the running-terminal gate
// performs; dispose/release/disposeWorkspace are inert spies.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  ptyForPanel: new Map<string, string>(),
  wsForPty: new Map<string, string>(),
}))

vi.mock('./logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

vi.mock('./terminal/terminalRegistry', () => ({
  terminalRegistry: {
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
    entries: () => [],
  },
}))

// Agent pi sessions are out of scope; stub so the appStore graph stays light.
vi.mock('../../agent/renderer/agentSessionRegistry', () => ({
  disposeAgentPanel: vi.fn(),
  getAgentPanelSession: vi.fn(),
  saveAgentPanelSession: vi.fn(),
}))

import { useAppStore } from '../stores/appStore'
import { useStatusStore } from '../stores/statusStore'
import { releaseWorkspaceDockStore } from './workspace/dockRegistry'
import { closeAllPanelsWithConfirm, removeWorkspacesWithConfirm } from './closePanelWithConfirm'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const confirmUnsavedChanges = vi.fn()
const confirmCloseTerminal = vi.fn()

function panel(id: string, type: PanelState['type'], extra: Partial<PanelState> = {}): PanelState {
  return { id, type, title: id, isDirty: false, ...extra } as PanelState
}

function workspace(id: string, panels: PanelState[]): WorkspaceState {
  return {
    id,
    name: `WS ${id}`,
    color: '',
    rootPath: `/tmp/${id}`,
    rootPathError: null,
    isRootPathPending: false,
    worktrees: [],
    panels: Object.fromEntries(panels.map((p) => [p.id, p])),
  } as unknown as WorkspaceState
}

function panelsOf(wsId: string): Record<string, PanelState> {
  return useAppStore.getState().workspaces.find((w) => w.id === wsId)?.panels ?? {}
}

/** Mark a terminal panel's PTY as running a foreground process. */
function markRunning(wsId: string, panelId: string, processName: string): void {
  const ptyId = `pty-${panelId}`
  h.ptyForPanel.set(panelId, ptyId)
  h.wsForPty.set(ptyId, wsId)
  useStatusStore.setState((s) => ({
    workspaces: {
      ...s.workspaces,
      [wsId]: {
        terminals: {
          ...(s.workspaces[wsId]?.terminals ?? {}),
          [ptyId]: {
            activity: { type: 'running', processName },
            agentState: 'notRunning',
            agentName: null,
            agentPresent: false,
            listeningPorts: [],
            cwd: '',
          },
        },
      },
    },
  }))
}

const initialAppState = useAppStore.getState()
let usedWorkspaceIds: string[] = []

function seed(...workspaces: WorkspaceState[]): void {
  usedWorkspaceIds = workspaces.map((w) => w.id)
  useAppStore.setState({ workspaces, selectedWorkspaceId: workspaces[0]?.id } as never)
}

beforeEach(() => {
  for (const id of usedWorkspaceIds) releaseWorkspaceDockStore(id)
  usedWorkspaceIds = []
  useAppStore.setState(initialAppState, true)
  useStatusStore.setState({ workspaces: {} })
  h.ptyForPanel.clear()
  h.wsForPty.clear()
  confirmUnsavedChanges.mockReset()
  confirmCloseTerminal.mockReset()
  const g = globalThis as unknown as { window?: { electronAPI?: unknown } }
  g.window = g.window ?? {}
  g.window.electronAPI = {
    confirmUnsavedChanges,
    confirmCloseTerminal,
    workspaceCreate: vi.fn(async () => ({ ok: true, workspace: {} })),
    workspaceUpdate: vi.fn(async () => ({ ok: true, workspace: {} })),
    workspaceRemove: vi.fn(async () => ({ ok: true })),
    recentProjectsAdd: vi.fn(),
    recentProjectsRemove: vi.fn(async () => undefined),
    agentDispose: vi.fn(async () => undefined),
  }
})

// ---------------------------------------------------------------------------
// closeAllPanelsWithConfirm
// ---------------------------------------------------------------------------

describe('closeAllPanelsWithConfirm', () => {
  it('dirty editor + cancel → returns false and closes nothing', async () => {
    seed(workspace('ws-a', [
      panel('cv', 'canvas'),
      panel('e1', 'editor', { isDirty: true, title: 'file.ts •', filePath: '/x/file.ts' }),
      panel('t1', 'terminal'),
    ]))
    confirmUnsavedChanges.mockResolvedValue('cancel')

    const before = panelsOf('ws-a')
    const ok = await closeAllPanelsWithConfirm('ws-a')

    expect(ok).toBe(false)
    expect(confirmUnsavedChanges).toHaveBeenCalledTimes(1)
    expect(panelsOf('ws-a')).toEqual(before) // untouched — nothing was closed
  })

  it('dirty editor + discard → panels are closed', async () => {
    seed(workspace('ws-b', [
      panel('e1', 'editor', { isDirty: true, title: 'file.ts •', filePath: '/x/file.ts' }),
      panel('t1', 'terminal'),
    ]))
    confirmUnsavedChanges.mockResolvedValue('discard')

    const ok = await closeAllPanelsWithConfirm('ws-b')

    expect(ok).toBe(true)
    expect(panelsOf('ws-b')['e1']).toBeUndefined()
    expect(panelsOf('ws-b')['t1']).toBeUndefined()
  })

  it('running terminal + cancel → returns false, panels remain; close → closed', async () => {
    seed(workspace('ws-c', [panel('t1', 'terminal'), panel('e1', 'editor')]))
    markRunning('ws-c', 't1', 'vim')
    confirmCloseTerminal.mockResolvedValueOnce('cancel')

    expect(await closeAllPanelsWithConfirm('ws-c')).toBe(false)
    expect(confirmCloseTerminal).toHaveBeenCalledWith({ count: 1, processName: 'vim' })
    expect(panelsOf('ws-c')['t1']).toBeDefined()
    expect(panelsOf('ws-c')['e1']).toBeDefined()

    confirmCloseTerminal.mockResolvedValueOnce('close')
    expect(await closeAllPanelsWithConfirm('ws-c')).toBe(true)
    expect(panelsOf('ws-c')['t1']).toBeUndefined()
    expect(panelsOf('ws-c')['e1']).toBeUndefined()
  })

  it('clean panels → closes without showing any dialog', async () => {
    seed(workspace('ws-d', [panel('e1', 'editor'), panel('t1', 'terminal')]))

    const ok = await closeAllPanelsWithConfirm('ws-d')

    expect(ok).toBe(true)
    expect(confirmUnsavedChanges).not.toHaveBeenCalled()
    expect(confirmCloseTerminal).not.toHaveBeenCalled()
    expect(panelsOf('ws-d')['e1']).toBeUndefined()
    expect(panelsOf('ws-d')['t1']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// removeWorkspacesWithConfirm
// ---------------------------------------------------------------------------

describe('removeWorkspacesWithConfirm', () => {
  it('aggregates dirty editors across ALL workspaces into ONE dialog; cancel keeps both', async () => {
    seed(
      workspace('ws-1', [panel('e1', 'editor', { isDirty: true, title: 'a.ts •', filePath: '/x/a.ts' })]),
      workspace('ws-2', [panel('e2', 'editor', { isDirty: true, title: 'b.ts •', filePath: '/x/b.ts' })]),
    )
    confirmUnsavedChanges.mockResolvedValue('cancel')

    const ok = await removeWorkspacesWithConfirm(['ws-1', 'ws-2'])

    expect(ok).toBe(false)
    // ONE aggregate dialog covering both workspaces' dirty editors.
    expect(confirmUnsavedChanges).toHaveBeenCalledTimes(1)
    expect(confirmUnsavedChanges).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: true, fileName: '2 files' }),
    )
    // Both workspaces (and their panels) remain.
    const ids = useAppStore.getState().workspaces.map((w) => w.id)
    expect(ids).toContain('ws-1')
    expect(ids).toContain('ws-2')
    expect(panelsOf('ws-1')['e1']).toBeDefined()
    expect(panelsOf('ws-2')['e2']).toBeDefined()
  })

  it('confirm → both workspaces are removed', async () => {
    seed(
      workspace('ws-1', [panel('e1', 'editor', { isDirty: true, title: 'a.ts •', filePath: '/x/a.ts' })]),
      workspace('ws-2', [panel('e2', 'editor', { isDirty: true, title: 'b.ts •', filePath: '/x/b.ts' })]),
    )
    confirmUnsavedChanges.mockResolvedValue('discard')

    const ok = await removeWorkspacesWithConfirm(['ws-1', 'ws-2'])

    expect(ok).toBe(true)
    expect(confirmUnsavedChanges).toHaveBeenCalledTimes(1)
    const ids = useAppStore.getState().workspaces.map((w) => w.id)
    expect(ids).not.toContain('ws-1')
    expect(ids).not.toContain('ws-2')
  })

  it('runs the running-terminal gate once for the whole batch', async () => {
    seed(
      workspace('ws-1', [panel('t1', 'terminal')]),
      workspace('ws-2', [panel('t2', 'terminal')]),
    )
    markRunning('ws-1', 't1', 'vim')
    markRunning('ws-2', 't2', 'npm')
    confirmCloseTerminal.mockResolvedValue('close')

    const ok = await removeWorkspacesWithConfirm(['ws-1', 'ws-2'])

    expect(ok).toBe(true)
    expect(confirmCloseTerminal).toHaveBeenCalledTimes(1)
    expect(confirmCloseTerminal).toHaveBeenCalledWith({ count: 2, processName: null })
    const ids = useAppStore.getState().workspaces.map((w) => w.id)
    expect(ids).not.toContain('ws-1')
    expect(ids).not.toContain('ws-2')
  })
})
