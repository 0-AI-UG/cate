import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, existsSync } from 'fs'
import path from 'path'
import { tmpdir } from 'os'

const fsExists = (p: string): boolean => existsSync(p)

// projectWorkspaceStore imports electron + a few main-only modules at load time.
// Mock them so the module can be imported under vitest's node environment.
// ipcMain.handle captures the registered handlers so the live IPC save path can
// be driven directly (it's the real production callsite, not saveProjectStateLocal).
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}))
vi.mock('./logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('./windowRegistry', () => ({ broadcastToAll: vi.fn() }))
vi.mock('./cateGitignore', () => ({ ensureCateGitignore: vi.fn(async () => {}) }))
// The live handler skips saving when another instance owns the project lock;
// always grant it so the save path runs.
vi.mock('./projectLock', () => ({
  holdsProjectLock: () => true,
  acquireProjectLock: () => true,
}))

// saveProjectStateLocal is the core the live PROJECT_STATE_SAVE handler runs
// (queueing + external-edit + issue #220 empty-overwrite guards). Exercising it
// directly keeps these tests on the production write path, not a dead wrapper.
import {
  saveProjectStateLocal,
  loadProjectState,
  saveProjectStateSync,
  registerProjectStateHandlers,
} from './projectWorkspaceStore'
import { PROJECT_STATE_SAVE, WORKSPACE_EXTERNAL_EDIT_DISMISS } from '../shared/ipc-channels'
import type { ProjectWorkspaceFile, ProjectSessionFile, CanvasNodeState } from '../shared/types'

function makeNode(panelId: string): CanvasNodeState {
  return {
    id: `node-${panelId}`,
    dockLayout: { type: 'tabs', id: `stack-${panelId}`, panelIds: [panelId], activeIndex: 0 },
    origin: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    zOrder: 0,
    creationIndex: 0,
  }
}

function makeWorkspace(nodes: CanvasNodeState[]): ProjectWorkspaceFile {
  const canvasNodes: Record<string, CanvasNodeState> = {}
  for (const n of nodes) canvasNodes[n.id] = n
  return {
    version: 1,
    name: 'WS',
    color: '',
    canvases: { cv: { id: 'cv', canvasNodes, zoomLevel: 1, viewportOffset: { x: 0, y: 0 } } },
  }
}

function makeSession(): ProjectSessionFile {
  return { version: 1, panels: {} }
}

/** Total canvas nodes across every canvas — what the #220 guard compares. */
function nodeCount(ws: ProjectWorkspaceFile): number {
  return Object.values(ws.canvases ?? {}).reduce((n, c) => n + Object.keys(c.canvasNodes).length, 0)
}

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'cate-pws-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function readWorkspaceJson(rootPath: string): Promise<ProjectWorkspaceFile> {
  const raw = await fs.readFile(path.join(rootPath, '.cate', 'workspace.json'), 'utf-8')
  return JSON.parse(raw) as ProjectWorkspaceFile
}

describe('saveProjectState — issue #220 empty-overwrite guard', () => {
  it('persists a non-empty canvas normally', async () => {
    await saveProjectStateLocal(root, makeWorkspace([makeNode('a'), makeNode('b')]), makeSession())
    expect(nodeCount(await readWorkspaceJson(root))).toBe(2)
  })

  it('refuses to overwrite a non-empty canvas with an empty one', async () => {
    await saveProjectStateLocal(root, makeWorkspace([makeNode('a'), makeNode('b')]), makeSession())
    // A racey activation save serializes an empty canvas — must be rejected.
    await saveProjectStateLocal(root, makeWorkspace([]), makeSession())
    expect(nodeCount(await readWorkspaceJson(root))).toBe(2)
  })

  it('allows an empty canvas when nothing (or only empty) is on disk', async () => {
    await saveProjectStateLocal(root, makeWorkspace([]), makeSession())
    expect(nodeCount(await readWorkspaceJson(root))).toBe(0)
  })

  it('still allows shrinking a non-empty canvas to a smaller non-empty one', async () => {
    await saveProjectStateLocal(root, makeWorkspace([makeNode('a'), makeNode('b')]), makeSession())
    await saveProjectStateLocal(root, makeWorkspace([makeNode('a')]), makeSession())
    expect(nodeCount(await readWorkspaceJson(root))).toBe(1)
  })
})

describe('loadProjectState — issue #220 prefer-richer fallback', () => {
  it('recovers a richer .bak when the primary file was wiped to empty', async () => {
    const cateDir = path.join(root, '.cate')
    await fs.mkdir(cateDir, { recursive: true })
    const wsPath = path.join(cateDir, 'workspace.json')
    // Primary file is structurally valid but empty (the data-loss footgun);
    // .bak still holds the good canvas.
    await fs.writeFile(wsPath, JSON.stringify(makeWorkspace([])), 'utf-8')
    await fs.writeFile(wsPath + '.bak', JSON.stringify(makeWorkspace([makeNode('a'), makeNode('b')])), 'utf-8')
    await fs.writeFile(path.join(cateDir, 'session.json'), JSON.stringify(makeSession()), 'utf-8')

    const loaded = await loadProjectState(root)
    expect(loaded).not.toBeNull()
    expect(nodeCount(loaded!.workspace)).toBe(2)
  })

  it('uses the primary file when it is the richest', async () => {
    const cateDir = path.join(root, '.cate')
    await fs.mkdir(cateDir, { recursive: true })
    const wsPath = path.join(cateDir, 'workspace.json')
    await fs.writeFile(wsPath, JSON.stringify(makeWorkspace([makeNode('a'), makeNode('b'), makeNode('c')])), 'utf-8')
    await fs.writeFile(wsPath + '.bak', JSON.stringify(makeWorkspace([makeNode('a')])), 'utf-8')
    await fs.writeFile(path.join(cateDir, 'session.json'), JSON.stringify(makeSession()), 'utf-8')

    const loaded = await loadProjectState(root)
    expect(nodeCount(loaded!.workspace)).toBe(3)
  })

  it('sweeps orphaned <file>.<pid>.<seq>.tmp files left by a crashed write', async () => {
    const cateDir = path.join(root, '.cate')
    await fs.mkdir(cateDir, { recursive: true })
    const wsPath = path.join(cateDir, 'workspace.json')
    await fs.writeFile(wsPath, JSON.stringify(makeWorkspace([makeNode('a')])), 'utf-8')
    await fs.writeFile(path.join(cateDir, 'session.json'), JSON.stringify(makeSession()), 'utf-8')
    // Orphans the uniquified writers leave behind on a crash between write+rename.
    const orphan = wsPath + '.12345.7.tmp'
    await fs.writeFile(orphan, 'garbage', 'utf-8')
    await fs.writeFile(path.join(cateDir, 'session.json.999.1.tmp'), 'garbage', 'utf-8')
    // A real persisted file with a similar-but-wrong shape must be left alone.
    await fs.writeFile(wsPath + '.bak', JSON.stringify(makeWorkspace([makeNode('a')])), 'utf-8')

    await loadProjectState(root)

    expect(fsExists(orphan)).toBe(false)
    expect(fsExists(path.join(cateDir, 'session.json.999.1.tmp'))).toBe(false)
    expect(fsExists(wsPath + '.bak')).toBe(true)
  })
})

const save = (rootPath: string, ws: ProjectWorkspaceFile, sess: ProjectSessionFile) =>
  handlers.get(PROJECT_STATE_SAVE)!(null, rootPath, ws, sess) as Promise<void>

describe('PROJECT_STATE_SAVE handler — live production save path (issue #220)', () => {
  beforeEach(() => {
    handlers.clear()
    registerProjectStateHandlers()
  })

  it('persists a non-empty canvas through the IPC handler', async () => {
    await save(root, makeWorkspace([makeNode('a'), makeNode('b')]), makeSession())
    expect(nodeCount(await readWorkspaceJson(root))).toBe(2)
  })

  it('the live handler refuses an empty overwrite of a non-empty canvas', async () => {
    await save(root, makeWorkspace([makeNode('a'), makeNode('b')]), makeSession())
    // Before the fix the inline handler had no node-count check and clobbered this.
    await save(root, makeWorkspace([]), makeSession())
    expect(nodeCount(await readWorkspaceJson(root))).toBe(2)
  })
})

describe('saveProjectStateSync — quit-time guard ordering (issue #220)', () => {
  beforeEach(() => {
    handlers.clear()
    registerProjectStateHandlers()
  })

  it('does not copy an already-emptied primary over a rich .bak when flushing empty', async () => {
    // Live save records lastSavedProjectStates and writes the good canvas.
    await save(root, makeWorkspace([makeNode('a'), makeNode('b')]), makeSession())
    const wsPath = path.join(root, '.cate', 'workspace.json')
    // Queue an empty canvas as the last live save (the guard skips its on-disk
    // write, but lastSavedProjectStates now holds the empty snapshot).
    await save(root, makeWorkspace([]), makeSession())
    // Simulate the primary already wiped to empty in a degraded build while .bak
    // still holds the rich canvas.
    await fs.writeFile(wsPath + '.bak', JSON.stringify(makeWorkspace([makeNode('a'), makeNode('b')])), 'utf-8')
    await fs.writeFile(wsPath, JSON.stringify(makeWorkspace([])), 'utf-8')
    // Drop the remembered hash so the external-edit guard stands down and the
    // quit flush genuinely exercises wouldEmptyOverwriteWorkspaceSync's .bak tier.
    await handlers.get(WORKSPACE_EXTERNAL_EDIT_DISMISS)!(null, root)

    saveProjectStateSync()

    // The quit flush must consult .bak's richness and refuse the empty overwrite,
    // so atomicWriteSync never copies the empty primary over the rich .bak.
    expect(nodeCount(JSON.parse(await fs.readFile(wsPath + '.bak', 'utf-8')))).toBe(2)
    expect(nodeCount(await readWorkspaceJson(root))).toBe(0)
  })

  it('flushes a non-empty canvas synchronously on quit', async () => {
    await save(root, makeWorkspace([makeNode('a')]), makeSession())
    // Mutate the live snapshot to two nodes and quit-flush it.
    await save(root, makeWorkspace([makeNode('a'), makeNode('b')]), makeSession())
    saveProjectStateSync()
    expect(nodeCount(await readWorkspaceJson(root))).toBe(2)
  })
})
