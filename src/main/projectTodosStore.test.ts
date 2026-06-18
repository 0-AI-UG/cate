import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, existsSync } from 'fs'
import path from 'path'
import { tmpdir } from 'os'

// projectTodosStore pulls in electron + main-only deps at import time; mock them
// so it loads under vitest's node environment.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))
vi.mock('./logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('./cateGitignore', () => ({ ensureCateGitignore: vi.fn(async () => {}) }))

import { loadTodos, saveTodos } from './projectTodosStore'
import type { Todo } from '../shared/types'

function makeTodo(over: Partial<Todo> = {}): Todo {
  return { id: 't1', title: 'do a thing', origin: 'user', status: 'pending', createdAt: 1, ...over }
}

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'cate-todos-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('projectTodosStore', () => {
  it('returns [] when the file is absent', async () => {
    expect(await loadTodos(root)).toEqual([])
  })

  it('round-trips a saved list', async () => {
    const todos = [makeTodo(), makeTodo({ id: 't2', title: 'second', status: 'done', updatedAt: 5 })]
    await saveTodos(root, todos)
    expect(existsSync(path.join(root, '.cate', 'todos.json'))).toBe(true)
    expect(await loadTodos(root)).toEqual(todos)
  })

  it('drops malformed entries and defaults a bad status', async () => {
    const file = {
      version: 1,
      todos: [
        { id: 'ok', title: 'keep', origin: 'user', status: 'weird', createdAt: 2 },
        { id: 42, title: 'no id' }, // dropped — id not a string
        { title: 'no id field' }, // dropped
        'nonsense', // dropped
      ],
    }
    await fs.mkdir(path.join(root, '.cate'), { recursive: true })
    await fs.writeFile(path.join(root, '.cate', 'todos.json'), JSON.stringify(file), 'utf-8')
    const loaded = await loadTodos(root)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({ id: 'ok', status: 'pending' }) // unknown status -> pending
  })

  it('returns [] on unparseable JSON instead of throwing', async () => {
    await fs.mkdir(path.join(root, '.cate'), { recursive: true })
    await fs.writeFile(path.join(root, '.cate', 'todos.json'), '{ not json', 'utf-8')
    expect(await loadTodos(root)).toEqual([])
  })

  it('preserves the richer Cate Agent fields (worktree, terminals, note)', async () => {
    const cateAgentTodo = makeTodo({
      id: 'p1',
      origin: 'cateAgent',
      status: 'in_progress',
      worktreeId: 'wt-1',
      branch: 'cate-agent/p1',
      terminalNodeIds: ['n1', 'n2'],
      note: 'because reasons',
    })
    await saveTodos(root, [cateAgentTodo])
    expect(await loadTodos(root)).toEqual([cateAgentTodo])
  })
})
