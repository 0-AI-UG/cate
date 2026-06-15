// =============================================================================
// projectTodosStore — per-workspace todo list at `<project>/.cate/todos.json`.
//
// The Cate Agent's shared task store: the user adds/checks todos from the Tasks
// sidebar, and later phases (observer/executor) read and mutate the same file.
// Machine-local by default — the `.cate/.gitignore` written elsewhere ignores
// everything but workspace.json, so todos.json never lands in the user's VCS.
//
// Persistence mirrors the projectWorkspaceStore contract (load/save IPC, atomic
// tmp+rename writes) but stays deliberately small: todos are low-stakes and the
// renderer holds the authoritative in-memory list, so there's no external-edit
// SHA guard or quit-time sync flush here.
// =============================================================================

import { ipcMain } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import log from './logger'
import { PROJECT_TODOS_LOAD, PROJECT_TODOS_SAVE } from '../shared/ipc-channels'
import type { Todo, ProjectTodosFile } from '../shared/types'
import { writeJsonAtomic } from './writeJsonAtomic'
import { ensureCateGitignore } from './cateGitignore'
import { isLocalLocator } from './companion/locator'

const CATE_DIR = '.cate'
const TODOS_FILE = 'todos.json'

function cateDir(rootPath: string): string {
  return path.join(rootPath, CATE_DIR)
}

function todosPath(rootPath: string): string {
  return path.join(rootPath, CATE_DIR, TODOS_FILE)
}

const VALID_STATUS = new Set(['suggested', 'pending', 'in_progress', 'review', 'done', 'failed', 'discarded'])

/** Coerce one raw parsed entry into a complete Todo, or null if unusable. A
 *  hand-edited / partial file must degrade gracefully rather than crash. */
function normalizeTodo(raw: unknown): Todo | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.title !== 'string') return null
  const status = typeof o.status === 'string' && VALID_STATUS.has(o.status) ? (o.status as Todo['status']) : 'pending'
  const origin = o.origin === 'cateAgent' ? 'cateAgent' : 'user'
  const todo: Todo = {
    id: o.id,
    title: o.title,
    origin,
    status,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
  }
  if (typeof o.updatedAt === 'number') todo.updatedAt = o.updatedAt
  if (typeof o.worktreeId === 'string') todo.worktreeId = o.worktreeId
  if (typeof o.branch === 'string') todo.branch = o.branch
  if (Array.isArray(o.terminalNodeIds)) todo.terminalNodeIds = o.terminalNodeIds.filter((x): x is string => typeof x === 'string')
  if (typeof o.note === 'string') todo.note = o.note
  return todo
}

/** Read `.cate/todos.json` for a local project. Missing/corrupt → []. */
export async function loadTodos(rootPath: string): Promise<Todo[]> {
  if (!isLocalLocator(rootPath)) return [] // remote todos unsupported in this phase
  try {
    const raw = await fs.readFile(todosPath(rootPath), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ProjectTodosFile>
    if (!parsed || !Array.isArray(parsed.todos)) return []
    return parsed.todos.map(normalizeTodo).filter((t): t is Todo => t !== null)
  } catch {
    return [] // absent or unparseable — start empty
  }
}

/** Persist the whole todo list for a local project (atomic tmp+rename). */
export async function saveTodos(rootPath: string, todos: Todo[]): Promise<void> {
  if (!isLocalLocator(rootPath)) return
  const file: ProjectTodosFile = { version: 1, todos }
  await ensureCateGitignore(cateDir(rootPath))
  await writeJsonAtomic(todosPath(rootPath), file)
}

export function registerProjectTodoHandlers(): void {
  ipcMain.handle(PROJECT_TODOS_LOAD, async (_event, rootPath: string) => loadTodos(rootPath))

  ipcMain.handle(PROJECT_TODOS_SAVE, async (_event, rootPath: string, todos: Todo[]) => {
    try {
      await saveTodos(rootPath, todos)
    } catch (err) {
      log.warn('[projectTodosStore] save failed for %s: %O', cateDir(rootPath), err)
    }
  })
}
