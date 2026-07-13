import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, existsSync } from 'fs'
import path from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('./logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('./cateGitignore', () => ({
  ensureCateGitignore: vi.fn(async () => {}),
  CATE_GITIGNORE_CONTENT: '*\n!workspace.json\n',
}))

// In-memory host fs behind runtime.file for the remote branch.
const hostFiles = vi.hoisted(() => new Map<string, string>())
vi.mock('./runtime/runtimeManager', () => ({
  runtimes: {
    resolve: () => ({
      file: {
        async readFile(p: string): Promise<string> {
          const v = hostFiles.get(p)
          if (v === undefined) throw new Error(`ENOENT: ${p}`)
          return v
        },
        async writeFile(p: string, content: string): Promise<void> {
          hostFiles.set(p, content)
        },
        async stat(p: string): Promise<{ isDirectory: boolean; isFile: boolean }> {
          if (!hostFiles.has(p)) throw new Error(`ENOENT: ${p}`)
          return { isDirectory: false, isFile: true }
        },
      },
    }),
  },
}))

import { loadCateAgentState, saveCateAgentState } from './projectCateAgentStore'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'cate-cate-agent-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('projectCateAgentStore', () => {
  it('defaults to automatic observations on when the file is absent', async () => {
    expect(await loadCateAgentState(root)).toEqual({ version: 1, autoObserve: true })
  })

  it('round-trips autoObserve', async () => {
    await saveCateAgentState(root, { version: 1, autoObserve: false })
    expect(existsSync(path.join(root, '.cate', 'cateAgent.json'))).toBe(true)
    expect(await loadCateAgentState(root)).toEqual({ version: 1, autoObserve: false })
  })

  it('defaults autoObserve when a valid file omits the field', async () => {
    await fs.mkdir(path.join(root, '.cate'), { recursive: true })
    await fs.writeFile(path.join(root, '.cate', 'cateAgent.json'), JSON.stringify({ version: 1 }), 'utf-8')
    expect(await loadCateAgentState(root)).toEqual({ version: 1, autoObserve: true })
  })

  it('coerces a non-boolean autoObserve back to the default', async () => {
    await fs.mkdir(path.join(root, '.cate'), { recursive: true })
    await fs.writeFile(path.join(root, '.cate', 'cateAgent.json'), JSON.stringify({ autoObserve: 0 }), 'utf-8')
    expect(await loadCateAgentState(root)).toEqual({ version: 1, autoObserve: true })
  })

  it('quarantines an unparseable file and returns defaults', async () => {
    await fs.mkdir(path.join(root, '.cate'), { recursive: true })
    await fs.writeFile(path.join(root, '.cate', 'cateAgent.json'), 'nope', 'utf-8')
    expect(await loadCateAgentState(root)).toEqual({ version: 1, autoObserve: true })
    // The broken content is preserved aside for recovery, not silently swallowed.
    const files = await fs.readdir(path.join(root, '.cate'))
    expect(files.some((f) => f.startsWith('cateAgent.json.corrupt-'))).toBe(true)
  })
})

describe('projectCateAgentStore — remote roots (through the runtime)', () => {
  const REMOTE_ROOT = 'cate-runtime://srv_abc/home/dev/project'
  const FILE = '/home/dev/project/.cate/cateAgent.json'
  const GITIGNORE = '/home/dev/project/.cate/.gitignore'

  beforeEach(() => hostFiles.clear())

  it('defaults when the remote file is absent', async () => {
    expect(await loadCateAgentState(REMOTE_ROOT)).toEqual({ version: 1, autoObserve: true })
    expect(hostFiles.size).toBe(0) // load never writes
  })

  it('round-trips autoObserve on the runtime host and seeds .gitignore once', async () => {
    await saveCateAgentState(REMOTE_ROOT, { version: 1, autoObserve: false })
    expect(hostFiles.has(FILE)).toBe(true)
    expect(hostFiles.has(GITIGNORE)).toBe(true)
    expect(await loadCateAgentState(REMOTE_ROOT)).toEqual({ version: 1, autoObserve: false })

    // A hand-edited .gitignore is not clobbered by the next save.
    hostFiles.set(GITIGNORE, 'custom')
    await saveCateAgentState(REMOTE_ROOT, { version: 1, autoObserve: true })
    expect(hostFiles.get(GITIGNORE)).toBe('custom')
  })

  it('degrades a corrupt remote file to defaults', async () => {
    hostFiles.set(FILE, 'nope')
    expect(await loadCateAgentState(REMOTE_ROOT)).toEqual({ version: 1, autoObserve: true })
  })
})
