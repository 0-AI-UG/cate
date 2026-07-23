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
  it('round-trips a chat with typed messages + the run loop layer', async () => {
    // The transcript blocks + the run's iteration layer (whose chips key off
    // agents[].terminalId) must all survive the disk round-trip.
    const chat: Chat = {
      id: 'c1',
      title: 'update readme',
      createdAt: 1,
      updatedAt: 2,
      hostPanelId: 'agent-panel-1',
      sessionFile: '/tmp/direct-chat.jsonl',
      engineeringTask: {
        goal: 'Refresh README.md',
        check: 'readme mentions the widget API',
        overview: 'Keep the existing structure.',
        acceptedAt: 8,
      },
      messages: [
        { id: 'm1', role: 'user', ts: 3, kind: 'text', text: 'update the readme' },
        { id: 'm2', role: 'agent', ts: 4, kind: 'plan', goal: 'Refresh README.md', check: 'readme mentions the widget API' },
        { id: 'm3', role: 'agent', ts: 5, kind: 'attempts', round: 1, recommendedIterationId: 'it-1', iterations: [] },
        { id: 'm4', role: 'agent', ts: 6, kind: 'result', iterationId: 'it-1', met: true, reason: 'looks good', worktreeId: 'wt-1', branch: 'cate/readme', outcome: 'merged', note: 'Merged into main' },
        { id: 'm5', role: 'agent', ts: 7, kind: 'canvas', request: 'open the readme', working: false, panels: [{ id: 'abc', type: 'editor', title: 'README.md' }], canvasPanelId: 'cv-1' },
      ],
      run: {
        status: 'review',
        goal: 'Refresh README.md',
        check: 'readme mentions the widget API',
        round: 1,
        recommendedIterationId: 'it-1',
        worktreeId: 'wt-1',
        branch: 'cate/readme',
        terminalNodeIds: ['390d9ec7'],
        canvasPanelId: 'cv-1',
        attemptsMessageId: 'm3',
        iterations: [
          {
            id: 'it-1',
            todoId: 'c1',
            round: 1,
            worktreeId: 'wt-1',
            branch: 'cate/readme',
            status: 'passed',
            createdAt: 5,
            agents: [
              { agent: 'coding agent', terminalId: '390d9ec7', scope: 'docs', kind: 'work' },
              { agent: 'verifier', terminalId: '7c0ffee0', kind: 'verify' },
            ],
            verify: { met: true, reason: 'looks good', at: 9 },
          },
        ],
      },
    }

    await saveChats(root, [chat])
    const [loaded] = await loadChats(root)

    expect(loaded).toEqual(chat)
    expect(loaded.run?.iterations?.[0].agents[0].terminalId).toBe('390d9ec7')
  })

  it('drops unknown message kinds + malformed iterations, the chat survives', async () => {
    await fs.mkdir(path.join(root, '.cate'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.cate', 'chats.json'),
      JSON.stringify({
        version: 1,
        chats: [
          {
            id: 'c1', title: 'x', createdAt: 1, updatedAt: 1,
            messages: [{ id: 'ok', role: 'agent', ts: 1, kind: 'text', text: 'hi' }, { id: 'bad', kind: 'bogus' }, null, 7],
            run: { status: 'running', iterations: [{ nope: true }, null] },
          },
        ],
      }),
      'utf-8',
    )
    const [loaded] = await loadChats(root)
    expect(loaded.id).toBe('c1')
    expect(loaded.messages.map((m) => m.id)).toEqual(['ok'])
    expect(loaded.run?.iterations).toEqual([])
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
    messages: [{ id: 'm1', role: 'user', ts: 3, kind: 'text', text: 'hello from afar' }],
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
