import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { PROJECT_STATE_SAVE, PROJECT_STATE_LOAD } from '../shared/ipc-channels'
import type { ProjectWorkspaceFile, ProjectSessionFile, CanvasNodeState } from '../shared/types'

// Captured IPC handlers, keyed by channel, so the test can drive them directly.
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
vi.mock('./windowRegistry', () => ({ broadcastToAll: vi.fn(), windowFromEvent: () => ({ id: 7 }) }))
vi.mock('./cateGitignore', () => ({
  ensureCateGitignore: vi.fn(async () => {}),
  CATE_GITIGNORE_CONTENT: '* \n!workspace.json\n',
}))

// A fake runtime whose file API is backed by a temp dir: the remote POSIX
// path is mapped under `hostRoot`, simulating files living on the runtime.
let hostRoot: string
const fileWrites: string[] = []
let writeFailure = false
let requireScope = false
function checkAccess(access?: { scopeId?: string; ownerWindowId?: number }): void {
  if (requireScope && (access?.scopeId !== 'remote-workspace' || access.ownerWindowId !== 7)) throw new Error('scope missing')
}
vi.mock('./runtime/runtimeManager', () => ({
  runtimes: {
    resolve: () => ({
      file: {
        async readFile(p: string, access?: { scopeId?: string; ownerWindowId?: number }): Promise<string> {
          checkAccess(access)
          return fs.readFile(path.join(hostRoot, p), 'utf-8')
        },
        async writeFile(p: string, content: string, access?: { scopeId?: string; ownerWindowId?: number }): Promise<void> {
          checkAccess(access)
          if (writeFailure) throw new Error('runtime disconnected')
          fileWrites.push(p)
          const full = path.join(hostRoot, p)
          await fs.mkdir(path.dirname(full), { recursive: true })
          await fs.writeFile(full, content, 'utf-8')
        },
        async stat(p: string, access?: { scopeId?: string; ownerWindowId?: number }): Promise<{ isDirectory: boolean; isFile: boolean }> {
          checkAccess(access)
          const st = await fs.stat(path.join(hostRoot, p))
          return { isDirectory: st.isDirectory(), isFile: st.isFile() }
        },
      },
    }),
  },
}))

import { registerProjectStateHandlers } from './projectWorkspaceStore'

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
    name: 'Remote WS',
    color: '',
    canvases: { cv: { id: 'cv', canvasNodes, zoomLevel: 1, viewportOffset: { x: 0, y: 0 } } },
  }
}

function makeSession(): ProjectSessionFile {
  return { version: 1, panels: {} }
}

function nodeCount(ws: ProjectWorkspaceFile): number {
  return Object.values(ws.canvases ?? {}).reduce((n, c) => n + Object.keys(c.canvasNodes).length, 0)
}

// cate-runtime://<id>/<posix path> — routed to the runtime, not local fs.
const LOCATOR = 'cate-runtime://srv1/remote/proj'

const save = (root: string, ws: ProjectWorkspaceFile, sess: ProjectSessionFile) =>
  handlers.get(PROJECT_STATE_SAVE)!(null, root, ws, sess) as Promise<void>
const load = (root: string) =>
  handlers.get(PROJECT_STATE_LOAD)!(null, root) as Promise<{
    workspace: ProjectWorkspaceFile
    session: ProjectSessionFile | null
  } | null>

beforeEach(async () => {
  handlers.clear()
  fileWrites.length = 0
  writeFailure = false
  requireScope = false
  hostRoot = await fs.mkdtemp(path.join(tmpdir(), 'cate-pws-remote-'))
  registerProjectStateHandlers()
})

afterEach(async () => {
  await fs.rm(hostRoot, { recursive: true, force: true })
})

describe('project state — remote (cate-runtime://) routing', () => {
  it('writes .cate/ next to the remote repo via the runtime, and round-trips', async () => {
    await save(LOCATOR, makeWorkspace([makeNode('a'), makeNode('b')]), makeSession())

    // Files landed at the remote repo's .cate/, addressed by POSIX path.
    expect(fileWrites).toContain('/remote/proj/.cate/workspace.json')
    expect(fileWrites).toContain('/remote/proj/.cate/session.json')

    const loaded = await load(LOCATOR)
    expect(loaded).not.toBeNull()
    expect(loaded!.workspace.name).toBe('Remote WS')
    expect(nodeCount(loaded!.workspace)).toBe(2)
  })

  it('refuses to overwrite a non-empty remote canvas with an empty one (#220 guard)', async () => {
    await save(LOCATOR, makeWorkspace([makeNode('a'), makeNode('b')]), makeSession())
    await expect(save(LOCATOR, makeWorkspace([]), makeSession())).rejects.toThrow(/empty/)
    const loaded = await load(LOCATOR)
    expect(nodeCount(loaded!.workspace)).toBe(2)
  })

  it('returns null when the remote repo has no .cate/ yet', async () => {
    expect(await load(LOCATOR)).toBeNull()
  })
  it('rejects failed writes so unchanged content can retry', async () => {
    writeFailure = true
    await expect(save(LOCATOR, makeWorkspace([makeNode('a')]), makeSession())).rejects.toThrow('runtime disconnected')
    writeFailure = false
    await save(LOCATOR, makeWorkspace([makeNode('a')]), makeSession())
    expect(await load(LOCATOR)).not.toBeNull()
  })

  it('protects layout without discarding newer recovery buffers', async () => {
    await save(LOCATOR, makeWorkspace([makeNode('a')]), makeSession())
    const session = { version: 1, panels: { editor: { panelId: 'editor', type: 'editor', unsavedContent: 'latest edits' } } } as ProjectSessionFile
    await expect(save(LOCATOR, makeWorkspace([]), session)).rejects.toThrow(/empty/)
    const loaded = await load(LOCATOR)
    expect(nodeCount(loaded!.workspace)).toBe(1)
    expect(loaded!.session?.panels.editor.unsavedContent).toBe('latest edits')
  })

  it('uses the owning workspace grant on every remote save/load operation', async () => {
    requireScope = true
    await handlers.get(PROJECT_STATE_SAVE)!({}, LOCATOR, makeWorkspace([makeNode('a')]), makeSession(), 'remote-workspace')
    const restored = await handlers.get(PROJECT_STATE_LOAD)!({}, LOCATOR, 'remote-workspace')
    expect(restored).not.toBeNull()
  })

  it('recovers a malformed remote primary from the validated previous version', async () => {
    await save(LOCATOR, makeWorkspace([makeNode('a')]), makeSession())
    await save(LOCATOR, makeWorkspace([makeNode('a'), makeNode('b')]), makeSession())
    await fs.writeFile(path.join(hostRoot, '/remote/proj/.cate/workspace.json'), '{broken')
    const restored = await load(LOCATOR)
    expect(nodeCount(restored!.workspace)).toBe(1)
  })

  it('uses the same external-layout protection while still saving recovery buffers', async () => {
    await save(LOCATOR, makeWorkspace([makeNode('a')]), makeSession())
    const external = { ...makeWorkspace([makeNode('b')]), name: 'External layout' }
    await fs.writeFile(path.join(hostRoot, '/remote/proj/.cate/workspace.json'), JSON.stringify(external))
    await expect(save(LOCATOR, makeWorkspace([makeNode('a')]), makeSession())).rejects.toThrow(/externally/)
    expect((await load(LOCATOR))!.workspace.name).toBe('External layout')
  })

})

it('persists an explicitly emptied remote layout', async () => {
  await save(LOCATOR, makeWorkspace([makeNode('a')]), makeSession())
  await handlers.get(PROJECT_STATE_SAVE)!(null, LOCATOR, makeWorkspace([]), makeSession(), undefined, { allowEmptyLayout: true })
  expect(nodeCount((await load(LOCATOR))!.workspace)).toBe(0)
})
