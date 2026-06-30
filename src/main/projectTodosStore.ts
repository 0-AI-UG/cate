// =============================================================================
// projectTodosStore — per-workspace todo list at `<project>/.cate/todos.json`.
//
// The Cate Agent's shared task store: the user adds/checks todos from the Tasks
// sidebar, and later phases (observer/orchestrator) read and mutate the same file.
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
import type { Todo, ProjectTodosFile, Iteration, IterationAgent, IterationStatus, VerifyResult } from '../shared/types'
import { writeJsonAtomic } from './writeJsonAtomic'
import { ensureCateGitignore } from './cateGitignore'
import { isLocalLocator } from './runtime/locator'

const CATE_DIR = '.cate'
const TODOS_FILE = 'todos.json'

function cateDir(rootPath: string): string {
  return path.join(rootPath, CATE_DIR)
}

function todosPath(rootPath: string): string {
  return path.join(rootPath, CATE_DIR, TODOS_FILE)
}

const VALID_STATUS = new Set(['suggested', 'pending', 'in_progress', 'review', 'done', 'failed', 'discarded'])
const VALID_ITERATION_STATUS = new Set<IterationStatus>([
  'running', 'finished', 'verifying', 'passed', 'failed', 'error', 'cancelled',
])

/** Coerce one raw agent record, dropping anything without a terminalId — the chip
 *  keys off it, so a record without one is useless. */
function normalizeAgent(raw: unknown): IterationAgent | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.terminalId !== 'string') return null
  const agent: IterationAgent = {
    agent: typeof o.agent === 'string' ? o.agent : 'coding agent',
    terminalId: o.terminalId,
  }
  if (typeof o.scope === 'string') agent.scope = o.scope
  if (o.kind === 'work' || o.kind === 'verify') agent.kind = o.kind
  return agent
}

/** Coerce one raw iteration. The terminal chips, goal/verdict lines, and round
 *  framing all read these, so they must survive the disk round-trip. */
function normalizeIteration(raw: unknown): Iteration | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.todoId !== 'string') return null
  const status = typeof o.status === 'string' && VALID_ITERATION_STATUS.has(o.status as IterationStatus)
    ? (o.status as IterationStatus)
    : 'running'
  const it: Iteration = {
    id: o.id,
    todoId: o.todoId,
    round: typeof o.round === 'number' ? o.round : 0,
    agents: Array.isArray(o.agents) ? o.agents.map(normalizeAgent).filter((a): a is IterationAgent => a !== null) : [],
    status,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
  }
  if (typeof o.worktreeId === 'string') it.worktreeId = o.worktreeId
  if (typeof o.branch === 'string') it.branch = o.branch
  const v = o.verify
  if (v && typeof v === 'object') {
    const vo = v as Record<string, unknown>
    if (typeof vo.reason === 'string' && typeof vo.at === 'number') {
      it.verify = { met: vo.met === true, reason: vo.reason, at: vo.at } satisfies VerifyResult
    }
  }
  return it
}

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
  // Cate-agent fields — the orchestrator's answer, derived title, and the whole
  // iteration/loop layer the job cards render. Dropping these on load silently
  // wiped the loop state (and the terminal chips' linkage) on every restart.
  if (typeof o.output === 'string') todo.output = o.output
  if (typeof o.topic === 'string') todo.topic = o.topic
  if (typeof o.goal === 'string') todo.goal = o.goal
  if (typeof o.check === 'string') todo.check = o.check
  if (typeof o.round === 'number') todo.round = o.round
  if (typeof o.recommendedIterationId === 'string') todo.recommendedIterationId = o.recommendedIterationId
  if (o.interrupted === true) todo.interrupted = true
  if (Array.isArray(o.iterations)) {
    todo.iterations = o.iterations.map(normalizeIteration).filter((i): i is Iteration => i !== null)
  }
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
