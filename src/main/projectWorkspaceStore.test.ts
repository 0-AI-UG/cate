import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import { tmpdir } from 'os'

// projectWorkspaceStore imports electron + a few main-only modules at load time.
// Mock them so the module can be imported under vitest's node environment.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  ipcMain: { handle: vi.fn() },
}))
vi.mock('./logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('./windowRegistry', () => ({ broadcastToAll: vi.fn() }))
vi.mock('./cateGitignore', () => ({ ensureCateGitignore: vi.fn(async () => {}) }))

import { saveProjectState, loadProjectState } from './projectWorkspaceStore'
import type { ProjectWorkspaceFile, ProjectSessionFile, CanvasNodeState } from '../shared/types'

function makeNode(panelId: string): CanvasNodeState {
  return {
    id: `node-${panelId}`,
    panelId,
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
    await saveProjectState(root, makeWorkspace([makeNode('a'), makeNode('b')]), makeSession())
    expect(nodeCount(await readWorkspaceJson(root))).toBe(2)
  })

  it('refuses to overwrite a non-empty canvas with an empty one', async () => {
    await saveProjectState(root, makeWorkspace([makeNode('a'), makeNode('b')]), makeSession())
    // A racey activation save serializes an empty canvas — must be rejected.
    await saveProjectState(root, makeWorkspace([]), makeSession())
    expect(nodeCount(await readWorkspaceJson(root))).toBe(2)
  })

  it('allows an empty canvas when nothing (or only empty) is on disk', async () => {
    await saveProjectState(root, makeWorkspace([]), makeSession())
    expect(nodeCount(await readWorkspaceJson(root))).toBe(0)
  })

  it('still allows shrinking a non-empty canvas to a smaller non-empty one', async () => {
    await saveProjectState(root, makeWorkspace([makeNode('a'), makeNode('b')]), makeSession())
    await saveProjectState(root, makeWorkspace([makeNode('a')]), makeSession())
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
})
