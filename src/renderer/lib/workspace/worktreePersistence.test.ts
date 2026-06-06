// =============================================================================
// Worktree session-persistence regression tests. Worktree colors/labels and each
// terminal/agent panel's worktree tag are machine-local (gitignored checkouts),
// so they live in session.json. These tests pin that they survive a save/restore
// round-trip — previously both were dropped, so colors got re-rolled from the
// palette on restart and terminals came back tagged to the primary worktree even
// though they respawn inside their worktree checkout.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))
vi.mock('../terminal/terminalRegistry', () => ({
  terminalRegistry: {
    dispose: vi.fn(),
    disposeWorkspace: vi.fn(),
    getEntry: vi.fn(),
    has: vi.fn(() => false),
  },
}))

beforeEach(() => {
  const g = globalThis as unknown as { window?: { electronAPI?: unknown } }
  g.window = g.window ?? {}
  g.window.electronAPI = {
    workspaceCreate: vi.fn(async (input: { id?: string; name?: string; rootPath?: string }) => ({
      ok: true,
      workspace: { id: input.id ?? 'gen', name: input.name ?? 'Workspace', color: '', rootPath: input.rootPath ?? '' },
    })),
    workspaceUpdate: vi.fn(async () => ({ ok: true, workspace: {} })),
    workspaceRemove: vi.fn(async () => ({ ok: true })),
    recentProjectsAdd: vi.fn(),
    recentProjectsRemove: vi.fn(async () => undefined),
  }
})

import { useAppStore } from '../../stores/appStore'
import { restoreSession, projectFilesToSnapshot } from './session'
import type {
  SessionSnapshot,
  WorktreeMeta,
  ProjectWorkspaceFile,
  ProjectSessionFile,
} from '../../../shared/types'

function reset() {
  for (const w of [...useAppStore.getState().workspaces]) {
    useAppStore.getState().removeWorkspace(w.id)
  }
}

const ROOT = '/tmp/wt'
// worktrees persist only UI metadata (id/path/color/label); branch/isPrimary are
// live git facts joined in at read time (see useWorktrees), never persisted.
const WT_X: WorktreeMeta = {
  id: 'wt-x', path: `${ROOT}/.cate/worktrees/x`, color: '#11aa55', label: 'X work',
}
const WT_PRIMARY: WorktreeMeta = {
  id: 'wt-primary-ws', path: ROOT, color: '#3366ff',
}

/** Editor-node snapshot carrying a persisted worktree registry. Editors don't
 *  need terminal mocks, so this isolates the worktree hydration path. */
function snapshotWithWorktrees(): SessionSnapshot {
  return {
    workspaceId: 'ws',
    workspaceName: 'restored',
    rootPath: ROOT,
    zoomLevel: 1,
    viewportOffset: { x: 0, y: 0 },
    nodes: [
      { panelId: 'ed-1', panelType: 'editor', title: 'file.ts', origin: { x: 0, y: 0 }, size: { width: 200, height: 150 }, filePath: `${ROOT}/file.ts` },
    ],
    worktrees: [WT_PRIMARY, WT_X],
  }
}

describe('worktree session persistence', () => {
  beforeEach(reset)

  it('restoreSession hydrates the worktree registry (colors/labels) into the workspace', async () => {
    const ws = useAppStore.getState().addWorkspace('WT', ROOT, 'ws')
    await restoreSession(snapshotWithWorktrees(), ws)

    const worktrees = useAppStore.getState().workspaces.find((w) => w.id === ws)!.worktrees ?? []
    const x = worktrees.find((w) => w.path === WT_X.path)
    expect(x?.color).toBe('#11aa55')
    expect(x?.label).toBe('X work')
    // The primary worktree is the one keyed by the workspace root path.
    expect(worktrees.find((w) => w.path === ROOT)?.color).toBe('#3366ff')
  })

  it('hydrateWorktrees merges by path so the persisted color wins over a discovered one', () => {
    const ws = useAppStore.getState().addWorkspace('WT', ROOT, 'ws')
    // Simulate a background sync that already discovered the same checkout with a
    // fresh palette color + a different (runtime) id, plus an unknown live one.
    useAppStore.getState().upsertWorktree(ws, { ...WT_X, id: 'wt-fresh', color: '#000000', label: undefined })
    const live: WorktreeMeta = { id: 'wt-live', path: `${ROOT}/.cate/worktrees/live`, color: '#999999' }
    useAppStore.getState().upsertWorktree(ws, live)

    useAppStore.getState().hydrateWorktrees(ws, [WT_X])

    const worktrees = useAppStore.getState().workspaces.find((w) => w.id === ws)!.worktrees ?? []
    const x = worktrees.filter((w) => w.path === WT_X.path)
    // Exactly one entry for that path, carrying the persisted id/color/label.
    expect(x).toHaveLength(1)
    expect(x[0]).toMatchObject({ id: 'wt-x', color: '#11aa55', label: 'X work' })
    // The live worktree the saved session didn't know about is preserved.
    expect(worktrees.some((w) => w.id === 'wt-live')).toBe(true)
  })

  it('hydrateWorktrees merges Windows paths that differ only by separator/case', () => {
    // On Windows git reports forward-slash paths (C:/proj) while the picker /
    // stored paths use native backslashes (C:\Proj). Raw string equality would
    // split one checkout into two; the normalized key must collapse them.
    const winRoot = 'C:\\Users\\me\\Proj'
    const ws = useAppStore.getState().addWorkspace('WT', winRoot, 'ws-win')
    // Background sync discovered the same checkout via git's forward-slash form,
    // lower-cased, with a fresh runtime id + palette color.
    const discovered: WorktreeMeta = {
      id: 'wt-fresh', path: 'c:/users/me/proj/.cate/worktrees/x', color: '#000000',
    }
    useAppStore.getState().upsertWorktree('ws-win', discovered)

    // Persisted session stored the native-separator form with color/label.
    const persisted: WorktreeMeta = {
      id: 'wt-x', path: 'C:\\Users\\me\\Proj\\.cate\\worktrees\\x', color: '#11aa55', label: 'X work',
    }
    useAppStore.getState().hydrateWorktrees('ws-win', [persisted])

    const worktrees = useAppStore.getState().workspaces.find((w) => w.id === 'ws-win')!.worktrees ?? []
    expect(worktrees).toHaveLength(1)
    expect(worktrees[0]).toMatchObject({ id: 'wt-x', color: '#11aa55', label: 'X work' })
  })

  it('projectFilesToSnapshot round-trips worktrees and per-node worktreeId from session.json', () => {
    const wsFile: ProjectWorkspaceFile = {
      version: 1,
      name: 'WT',
      color: '',
      canvas: {
        nodes: [{ panelId: 't-1', panelType: 'terminal', title: 'shell', origin: { x: 0, y: 0 }, size: { width: 200, height: 150 } }],
        zoomLevel: 1,
        viewportOffset: { x: 0, y: 0 },
      },
      dockPanels: { 'dt-1': { type: 'terminal', title: 'docked shell' } },
    }
    const sessFile: ProjectSessionFile = {
      version: 1,
      workspaceId: 'ws',
      nodes: {
        't-1': { panelId: 't-1', zOrder: 0, creationIndex: 0, workingDirectory: WT_X.path, worktreeId: 'wt-x' },
      },
      worktrees: [WT_PRIMARY, WT_X],
      dockPanelWorktreeIds: { 'dt-1': 'wt-x' },
    }

    const snap = projectFilesToSnapshot(wsFile, sessFile, ROOT)
    expect(snap.nodes[0].worktreeId).toBe('wt-x')
    expect(snap.worktrees).toEqual([WT_PRIMARY, WT_X])
    // Dock-zone terminal's worktree tag is re-attached from the side map.
    expect(snap.dockPanels?.['dt-1']?.worktreeId).toBe('wt-x')
  })
})
