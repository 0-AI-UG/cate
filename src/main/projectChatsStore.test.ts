import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
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

import { loadChats, saveChats } from './projectChatsStore'
import type { Chat } from '../shared/types'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'cate-chats-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('projectChatsStore', () => {
  it('round-trips main-agent session metadata', async () => {
    const chat: Chat = {
      id: 'c1',
      title: 'update readme',
      createdAt: 1,
      updatedAt: 2,
      hostPanelId: 'agent-panel-1',
      worktreeId: 'wt-feature',
      sessionFile: '/tmp/direct-chat.jsonl',
      model: { provider: 'anthropic', model: 'claude-sonnet' },
    }

    await saveChats(root, [chat])
    expect(await loadChats(root)).toEqual([chat])
  })

  it('drops legacy loop data while keeping the chat metadata', async () => {
    await fs.mkdir(path.join(root, '.cate'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.cate', 'chats.json'),
      JSON.stringify({
        version: 1,
        chats: [
          {
            id: 'c1', title: 'x', createdAt: 1, updatedAt: 1,
            messages: [{ id: 'legacy', role: 'agent', ts: 1, kind: 'text', text: 'hi' }],
            run: { status: 'running', iterations: [{ nope: true }, null] },
            legacyState: { goal: 'legacy', startedAt: 1 },
          },
        ],
      }),
      'utf-8',
    )
    const [loaded] = await loadChats(root)
    expect(loaded).toEqual({
      id: 'c1',
      title: 'x',
      createdAt: 1,
      updatedAt: 1,
    })
  })

  it('quarantines an unparseable chats.json and starts empty', async () => {
    await fs.mkdir(path.join(root, '.cate'), { recursive: true })
    await fs.writeFile(path.join(root, '.cate', 'chats.json'), '{ definitely not json', 'utf-8')
    expect(await loadChats(root)).toEqual([])
    // The broken content is preserved aside for recovery, not silently swallowed.
    const files = await fs.readdir(path.join(root, '.cate'))
    expect(files.some((f) => f.startsWith('chats.json.corrupt-'))).toBe(true)
  })
})

describe('projectChatsStore — remote roots (through the runtime)', () => {
  const REMOTE_ROOT = 'cate-runtime://srv_abc/home/dev/project'
  const FILE = '/home/dev/project/.cate/chats.json'
  const GITIGNORE = '/home/dev/project/.cate/.gitignore'

  const chat: Chat = {
    id: 'c1',
    title: 'remote chat',
    createdAt: 1,
    updatedAt: 2,
  }

  beforeEach(() => hostFiles.clear())

  it('loads empty when the remote file is absent', async () => {
    expect(await loadChats(REMOTE_ROOT)).toEqual([])
    expect(hostFiles.size).toBe(0) // load never writes
  })

  it('round-trips chats on the runtime host and seeds .gitignore once', async () => {
    await saveChats(REMOTE_ROOT, [chat])
    expect(hostFiles.has(FILE)).toBe(true)
    expect(hostFiles.has(GITIGNORE)).toBe(true)
    expect(await loadChats(REMOTE_ROOT)).toEqual([chat])

    // A hand-edited .gitignore is not clobbered by the next save.
    hostFiles.set(GITIGNORE, 'custom')
    await saveChats(REMOTE_ROOT, [chat])
    expect(hostFiles.get(GITIGNORE)).toBe('custom')
  })

  it('degrades a corrupt remote file to an empty list', async () => {
    hostFiles.set(FILE, '{ definitely not json')
    expect(await loadChats(REMOTE_ROOT)).toEqual([])
  })
})
