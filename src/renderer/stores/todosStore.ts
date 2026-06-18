// =============================================================================
// todosStore — renderer-side authority for per-workspace todos.
//
// Holds the live todo list keyed by project rootPath, and mirrors every mutation
// to `.cate/todos.json` via IPC. Keyed by root (not the single selected
// workspace) so multiple open workspaces keep independent lists and a re-select
// doesn't reload. Phase 1 surface: load + manual add/toggle/remove.
// =============================================================================

import { create } from 'zustand'
import type { Todo, TodoStatus } from '../../shared/types'
import { generateId } from './canvas/helpers'

interface TodosStoreState {
  /** Todos per project rootPath. */
  todosByRoot: Record<string, Todo[]>
  /** Roots whose list has been loaded from disk at least once. */
  loadedRoots: Record<string, boolean>
}

interface TodosStoreActions {
  /** Load `.cate/todos.json` for a root once; re-calls are cheap no-ops unless forced. */
  loadTodos: (rootPath: string, force?: boolean) => Promise<void>
  /** Append a manual (`user`) todo and persist. No-op on blank titles. */
  addTodo: (rootPath: string, title: string) => void
  /** Toggle a todo between `pending` and `done` and persist. */
  toggleTodo: (rootPath: string, id: string) => void
  /** Remove a todo and persist. */
  removeTodo: (rootPath: string, id: string) => void

  // --- Cate Agent-facing mutators (also used by the Tasks UI gates) ---
  /** Read the current list for a root (already-loaded; [] otherwise). */
  getTodos: (rootPath: string) => Todo[]
  /** Insert or replace a whole todo (used by the observer's propose_todo). */
  upsertTodo: (rootPath: string, todo: Todo) => void
  /** Patch a todo by id (status/note/worktree/branch/terminals) and persist. */
  patchTodo: (rootPath: string, id: string, patch: Partial<Todo>) => void
  /** Set a todo's status (+ stamp updatedAt) and persist. */
  setTodoStatus: (rootPath: string, id: string, status: TodoStatus) => void
}

export type TodosStore = TodosStoreState & TodosStoreActions

/** Persist a root's list to disk. Fire-and-forget; main does the atomic write. */
function persist(rootPath: string, todos: Todo[]): void {
  void window.electronAPI.projectTodosSave(rootPath, todos)
}

export const useTodosStore = create<TodosStore>((set, get) => ({
  todosByRoot: {},
  loadedRoots: {},

  async loadTodos(rootPath, force = false) {
    if (!rootPath) return
    if (!force && get().loadedRoots[rootPath]) return
    const todos = await window.electronAPI.projectTodosLoad(rootPath)
    set((s) => ({
      todosByRoot: { ...s.todosByRoot, [rootPath]: todos },
      loadedRoots: { ...s.loadedRoots, [rootPath]: true },
    }))
  },

  addTodo(rootPath, title) {
    const trimmed = title.trim()
    if (!rootPath || !trimmed) return
    const now = Date.now()
    const todo: Todo = {
      id: generateId(),
      title: trimmed,
      origin: 'user',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    }
    const next = [...(get().todosByRoot[rootPath] ?? []), todo]
    set((s) => ({ todosByRoot: { ...s.todosByRoot, [rootPath]: next } }))
    persist(rootPath, next)
  },

  toggleTodo(rootPath, id) {
    const current = get().todosByRoot[rootPath]
    if (!current) return
    const next = current.map((t) =>
      t.id === id
        ? { ...t, status: t.status === 'done' ? ('pending' as const) : ('done' as const), updatedAt: Date.now() }
        : t,
    )
    set((s) => ({ todosByRoot: { ...s.todosByRoot, [rootPath]: next } }))
    persist(rootPath, next)
  },

  removeTodo(rootPath, id) {
    const current = get().todosByRoot[rootPath]
    if (!current) return
    const next = current.filter((t) => t.id !== id)
    set((s) => ({ todosByRoot: { ...s.todosByRoot, [rootPath]: next } }))
    persist(rootPath, next)
  },

  getTodos(rootPath) {
    return get().todosByRoot[rootPath] ?? []
  },

  upsertTodo(rootPath, todo) {
    const current = get().todosByRoot[rootPath] ?? []
    const exists = current.some((t) => t.id === todo.id)
    const next = exists ? current.map((t) => (t.id === todo.id ? todo : t)) : [...current, todo]
    set((s) => ({
      todosByRoot: { ...s.todosByRoot, [rootPath]: next },
      loadedRoots: { ...s.loadedRoots, [rootPath]: true },
    }))
    persist(rootPath, next)
  },

  patchTodo(rootPath, id, patch) {
    const current = get().todosByRoot[rootPath]
    if (!current) return
    const next = current.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t))
    set((s) => ({ todosByRoot: { ...s.todosByRoot, [rootPath]: next } }))
    persist(rootPath, next)
  },

  setTodoStatus(rootPath, id, status) {
    get().patchTodo(rootPath, id, { status })
  },
}))
