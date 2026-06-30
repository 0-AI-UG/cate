import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('./logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('./cateGitignore', () => ({ ensureCateGitignore: vi.fn(async () => {}) }))

import { loadTodos, saveTodos } from './projectTodosStore'
import type { Todo } from '../shared/types'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'cate-todos-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('projectTodosStore', () => {
  it('round-trips the cate-agent loop layer (iterations + agents + terminalId)', async () => {
    // Regression: normalizeTodo used to drop iterations/goal/topic/round/output on
    // load, silently wiping the loop state and the terminal chips' panel linkage on
    // every restart. The job-card terminal chips key off iterations[].agents[].terminalId,
    // so that field in particular must survive the disk round-trip.
    const todo: Todo = {
      id: 't1',
      title: 'update readme',
      origin: 'cateAgent',
      status: 'in_progress',
      createdAt: 1,
      topic: 'Update README',
      goal: 'Refresh README.md',
      check: 'readme mentions the widget API',
      round: 2,
      recommendedIterationId: 'it-1',
      output: 'done',
      interrupted: true,
      iterations: [
        {
          id: 'it-1',
          todoId: 't1',
          round: 2,
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
    }

    await saveTodos(root, [todo])
    const [loaded] = await loadTodos(root)

    expect(loaded).toEqual(todo)
    expect(loaded.iterations?.[0].agents[0].terminalId).toBe('390d9ec7')
  })

  it('drops agent records with no terminalId (the chip cannot resolve them)', async () => {
    await fs.mkdir(path.join(root, '.cate'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.cate', 'todos.json'),
      JSON.stringify({
        version: 1,
        todos: [
          {
            id: 't1', title: 'x', origin: 'cateAgent', status: 'in_progress', createdAt: 1,
            iterations: [
              { id: 'it-1', todoId: 't1', round: 1, status: 'running', createdAt: 2, agents: [{ agent: 'codex' }] },
            ],
          },
        ],
      }),
      'utf-8',
    )
    const [loaded] = await loadTodos(root)
    expect(loaded.iterations?.[0].agents).toEqual([])
  })

  it('degrades gracefully: malformed iterations are dropped, the todo survives', async () => {
    await fs.mkdir(path.join(root, '.cate'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.cate', 'todos.json'),
      JSON.stringify({
        version: 1,
        todos: [
          { id: 't1', title: 'x', origin: 'user', status: 'pending', createdAt: 1, iterations: [{ nope: true }, null, 7] },
        ],
      }),
      'utf-8',
    )
    const [loaded] = await loadTodos(root)
    expect(loaded.id).toBe('t1')
    expect(loaded.iterations).toEqual([])
  })
})
