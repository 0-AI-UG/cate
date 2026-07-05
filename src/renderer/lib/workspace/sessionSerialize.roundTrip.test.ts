// =============================================================================
// Session persistence round-trip — SessionSnapshot → on-disk project files
// (.cate/workspace.json + .cate/session.json, through real JSON) → snapshot.
// Builds the dock layout and canvas geometry with the REAL dockStore /
// canvasStore so this exercises the same shapes saveSession persists, and
// asserts the shareable / machine-local split: workspace.json carries no
// absolute paths, scratch content, or worktree tags; session.json carries
// exactly those and nothing for panels that have none.
// =============================================================================

import { describe, it, expect } from 'vitest'
import {
  buildWorkspaceFile,
  buildSessionFile,
  projectFilesToSnapshot,
  collectPanelIdsFromDockState,
} from './sessionSerialize'
import { createDockStore } from '../../stores/dockStore'
import { createCanvasStore } from '../../stores/canvasStore'
import type {
  SessionSnapshot,
  PanelState,
  DetachedDockWindowSnapshot,
  CanvasSnapshot,
} from '../../../shared/types'

const ROOT = '/Users/dev/my-repo'
const WORKTREE_PATH = `${ROOT}/.cate/worktrees/fix-login`

function panel(p: Partial<PanelState> & Pick<PanelState, 'id' | 'type'>): PanelState {
  return { title: p.id, isDirty: false, ...p }
}

/** Build a realistic snapshot: a center canvas holding two editors, a bottom
 *  dock with a browser | terminal split, plus worktree + remote metadata. */
function buildSnapshot(): { snapshot: SessionSnapshot; canvasSnapshot: CanvasSnapshot } {
  // Dock layout via the real dock store.
  const dock = createDockStore()
  dock.getState().dockPanel('canvas-1', 'center')
  dock.getState().dockPanel('web-1', 'bottom')
  const webStack = dock.getState().getPanelLocation('web-1')!
  dock.getState().dockPanel('term-1', 'bottom', {
    type: 'split',
    stackId: webStack.type === 'dock' ? webStack.stackId : '',
    edge: 'right',
  })
  const dockState = dock.getState().getSnapshot()

  // Canvas geometry via the real canvas store.
  const canvas = createCanvasStore()
  canvas.getState().addNode('ed-1', 'editor', { x: 100, y: 80 }, { width: 600, height: 400 })
  canvas.getState().addNode('ed-scratch', 'editor', { x: 900, y: 80 }, { width: 500, height: 300 })
  canvas.getState().setZoomAndOffset(0.8, { x: -120, y: 40 })
  const canvasSnapshot: CanvasSnapshot = {
    id: 'canvas-1',
    canvasNodes: canvas.getState().nodes,
    zoomLevel: canvas.getState().zoomLevel,
    viewportOffset: canvas.getState().viewportOffset,
  }

  const snapshot: SessionSnapshot = {
    workspaceId: 'ws-uuid-1',
    workspaceName: 'My Repo',
    rootPath: ROOT,
    dockState,
    panels: {
      'canvas-1': panel({ id: 'canvas-1', type: 'canvas' }),
      'ed-1': panel({ id: 'ed-1', type: 'editor', filePath: `${ROOT}/src/app.ts` }),
      'ed-scratch': panel({ id: 'ed-scratch', type: 'editor', unsavedContent: 'SCRATCH-CONTENT' }),
      'term-1': panel({ id: 'term-1', type: 'terminal', worktreeId: 'wt-1' }),
      'web-1': panel({
        id: 'web-1',
        type: 'browser',
        url: 'http://localhost:3000',
        proxyUrl: 'http://user:pass@proxy:8080',
      }),
    },
    canvases: { 'canvas-1': canvasSnapshot },
    terminalCwds: { 'term-1': WORKTREE_PATH },
    worktrees: [{ id: 'wt-1', path: WORKTREE_PATH, color: '#ff5555', label: 'fix-login' }],
    connection: {
      kind: 'server',
      runtimeId: 'comp-1',
      host: 'devbox',
      user: 'anton',
      remotePath: '/srv/my-repo',
    },
  }
  return { snapshot, canvasSnapshot }
}

/** Simulate the disk: serialize to JSON text and parse back, like a real save/load. */
function throughDisk<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

describe('workspace.json + session.json round-trip', () => {
  it('restores an equivalent snapshot through real JSON serialization', () => {
    const { snapshot, canvasSnapshot } = buildSnapshot()

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT, '#00ff00'))
    const sessFile = throughDisk(buildSessionFile(snapshot))
    const restored = projectFilesToSnapshot(wsFile, sessFile, ROOT)

    // Identity + reconnect metadata.
    expect(restored.workspaceId).toBe('ws-uuid-1')
    expect(restored.workspaceName).toBe('My Repo')
    expect(restored.rootPath).toBe(ROOT)
    expect(restored.connection).toEqual(snapshot.connection)
    expect(restored.worktrees).toEqual(snapshot.worktrees)

    // Every placed panel comes back, with machine-local facts re-attached.
    expect(Object.keys(restored.panels!).sort()).toEqual(
      Object.keys(snapshot.panels!).sort(),
    )
    expect(restored.panels!['ed-1'].filePath).toBe(`${ROOT}/src/app.ts`)
    expect(restored.panels!['ed-scratch'].unsavedContent).toBe('SCRATCH-CONTENT')
    expect(restored.panels!['term-1'].worktreeId).toBe('wt-1')
    expect(restored.panels!['web-1'].url).toBe('http://localhost:3000')
    expect(restored.panels!['web-1'].proxyUrl).toBe('http://user:pass@proxy:8080')
    expect(restored.terminalCwds).toEqual({ 'term-1': WORKTREE_PATH })

    // Dock layout and canvas geometry survive byte-for-byte.
    expect(restored.dockState).toEqual(throughDisk(snapshot.dockState))
    expect(restored.canvases).toEqual(throughDisk({ 'canvas-1': canvasSnapshot }))
    expect(collectPanelIdsFromDockState(restored.dockState!.zones).sort()).toEqual([
      'canvas-1',
      'term-1',
      'web-1',
    ])
  })

  it('keeps machine-local facts OUT of the committed workspace.json', () => {
    const { snapshot } = buildSnapshot()

    const wsText = JSON.stringify(buildWorkspaceFile(snapshot, ROOT, ''))

    // No absolute paths — the editor's file is stored relative to the root.
    expect(wsText).not.toContain(ROOT)
    expect(wsText).toContain('"src/app.ts"')
    // No scratch buffers, worktree tags, or terminal cwds.
    expect(wsText).not.toContain('SCRATCH-CONTENT')
    expect(wsText).not.toContain('wt-1')
    expect(wsText).not.toContain('workingDirectory')
  })

  it('keeps shareable metadata OUT of session.json and skips panels with no machine-local facts', () => {
    const { snapshot } = buildSnapshot()

    const sessFile = buildSessionFile(snapshot)

    // Only the terminal (cwd + worktree) and the scratch editor have session facts.
    expect(Object.keys(sessFile.panels).sort()).toEqual(['ed-scratch', 'term-1'])
    expect(sessFile.panels['term-1']).toEqual({
      panelId: 'term-1',
      workingDirectory: WORKTREE_PATH,
      unsavedContent: undefined,
      worktreeId: 'wt-1',
    })
    const sessText = JSON.stringify(sessFile)
    expect(sessText).not.toContain('src/app.ts')
    expect(sessText).not.toContain('localhost:3000')
  })

  it('a file outside the workspace root keeps its absolute path through the round trip', () => {
    const { snapshot } = buildSnapshot()
    snapshot.panels!['ed-out'] = panel({
      id: 'ed-out',
      type: 'editor',
      filePath: '/etc/hosts',
    })

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT))
    const restored = projectFilesToSnapshot(wsFile, null, ROOT)

    expect(restored.panels!['ed-out'].filePath).toBe('/etc/hosts')
  })

  it('round-trips an extension panel so it re-binds to its extension on reload', () => {
    // Regression: extensionId/extensionPanelId used to be dropped by
    // buildWorkspaceFile, so a restored extension panel came back with no
    // extension binding and rendered "Extension unavailable" — even though a
    // freshly created one worked. They must survive the disk round-trip.
    const { snapshot } = buildSnapshot()
    snapshot.panels!['ext-1'] = panel({
      id: 'ext-1',
      type: 'extension',
      title: 'Kitchen Sink',
      extensionId: 'cate.kitchensink',
      extensionPanelId: 'main',
    })

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT, ''))
    // The binding is shareable metadata — it belongs in the committed file.
    expect(wsFile.panels!['ext-1'].extensionId).toBe('cate.kitchensink')
    expect(wsFile.panels!['ext-1'].extensionPanelId).toBe('main')

    const restored = projectFilesToSnapshot(wsFile, throughDisk(buildSessionFile(snapshot)), ROOT)
    expect(restored.panels!['ext-1'].type).toBe('extension')
    expect(restored.panels!['ext-1'].extensionId).toBe('cate.kitchensink')
    expect(restored.panels!['ext-1'].extensionPanelId).toBe('main')
  })

  it('leaves the extension binding undefined for non-extension panels', () => {
    const { snapshot } = buildSnapshot()
    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT))
    const restored = projectFilesToSnapshot(wsFile, null, ROOT)
    expect(restored.panels!['ed-1'].extensionId).toBeUndefined()
    expect(restored.panels!['ed-1'].extensionPanelId).toBeUndefined()
  })

  it('restores from workspace.json alone (no session.json) without machine-local facts', () => {
    const { snapshot } = buildSnapshot()

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT))
    const restored = projectFilesToSnapshot(wsFile, null, ROOT)

    expect(restored.workspaceId).toBeUndefined()
    expect(restored.connection).toBeUndefined()
    expect(restored.worktrees).toBeUndefined()
    expect(restored.terminalCwds).toBeUndefined()
    expect(restored.panels!['term-1'].worktreeId).toBeUndefined()
    // Shareable structure still restores fully.
    expect(restored.panels!['ed-1'].filePath).toBe(`${ROOT}/src/app.ts`)
    expect(restored.dockState).toEqual(throughDisk(snapshot.dockState))
    expect(restored.canvases).toEqual(throughDisk(snapshot.canvases))
  })

  it('includes detached dock windows in session.json only when there are any', () => {
    const { snapshot } = buildSnapshot()
    expect(buildSessionFile(snapshot, []).dockWindows).toBeUndefined()

    const detachedDock = createDockStore()
    detachedDock.getState().dockPanel('term-2', 'center')
    const dw: DetachedDockWindowSnapshot = {
      dockState: detachedDock.getState().getSnapshot(),
      panels: { 'term-2': panel({ id: 'term-2', type: 'terminal' }) },
      bounds: { x: 50, y: 60, width: 800, height: 600 },
      workspaceId: 'ws-uuid-1',
      terminalCwds: { 'term-2': ROOT },
    }

    const sessFile = throughDisk(buildSessionFile(snapshot, [dw]))
    expect(sessFile.dockWindows).toHaveLength(1)
    expect(sessFile.dockWindows![0].bounds).toEqual({ x: 50, y: 60, width: 800, height: 600 })
    expect(collectPanelIdsFromDockState(sessFile.dockWindows![0].dockState.zones)).toEqual([
      'term-2',
    ])
  })

  it('restores a bare workspace.json with no panels, canvases, or dock state', () => {
    const restored = projectFilesToSnapshot({ version: 1, name: 'Bare', color: '' }, null, ROOT)

    expect(restored.workspaceName).toBe('Bare')
    expect(restored.rootPath).toBe(ROOT)
    expect(restored.panels).toBeUndefined()
    expect(restored.canvases).toBeUndefined()
    expect(restored.dockState).toBeUndefined()
    expect(restored.terminalCwds).toBeUndefined()
  })

  it('ignores session.json entries for panels missing from workspace.json', () => {
    const { snapshot } = buildSnapshot()
    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT))
    // A stale session.json referencing a panel that was since closed.
    const staleSess = throughDisk(buildSessionFile(snapshot))
    staleSess.panels['ghost'] = {
      panelId: 'ghost',
      workingDirectory: '/tmp/elsewhere',
      worktreeId: 'wt-stale',
    }

    const restored = projectFilesToSnapshot(wsFile, staleSess, ROOT)

    expect(restored.panels!['ghost']).toBeUndefined()
    expect(restored.terminalCwds).toEqual({ 'term-1': WORKTREE_PATH })
  })

  it('a Windows-style root round-trips editor paths with native separators', () => {
    const winRoot = 'C:\\Users\\dev\\repo'
    const { snapshot } = buildSnapshot()
    snapshot.panels = {
      'ed-1': panel({ id: 'ed-1', type: 'editor', filePath: 'C:\\Users\\dev\\repo\\src\\app.ts' }),
    }

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, winRoot))
    expect(wsFile.panels!['ed-1'].filePath).toBe('src/app.ts')

    const restored = projectFilesToSnapshot(wsFile, null, winRoot)
    expect(restored.panels!['ed-1'].filePath).toBe('C:\\Users\\dev\\repo\\src\\app.ts')
  })
})
