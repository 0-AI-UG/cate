import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('./logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('./cateGitignore', () => ({ ensureCateGitignore: vi.fn(async () => {}) }))

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
