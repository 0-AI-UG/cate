// =============================================================================
// TasksView — the Canvas Pet's task panel.
//
// Manual tasks (add / check / delete) plus the pet workflow surfaced as status
// groups: Suggested (pet proposals → Approve & run / Dismiss), In progress (live
// executor + jump-to-terminal), Review (the land gate → Merge / PR / Discard),
// and Done/Failed history. A header summons/pauses/dismisses the pet.
// =============================================================================

import React, { useEffect, useState } from 'react'
import {
  Plus,
  Check,
  X,
  ListChecks,
  Play,
  Sparkle,
  Pause,
  ArrowsClockwise,
  GitMerge,
  GitPullRequest,
  Trash,
  ArrowSquareOut,
  CircleNotch,
  CaretRight,
} from '@phosphor-icons/react'
import { useTodosStore } from '../stores/todosStore'
import { useAppStore } from '../stores/appStore'
import { usePetWs } from '../pet/petStore'
import { petController } from '../pet/petController'
import { mergeTodo, openPrTodo, discardTodo } from '../pet/petReviewActions'
import { revealPanel } from '../lib/workspace/panelReveal'
import { SidebarSectionHeader, SidebarHeaderButton } from './SidebarSectionHeader'
import type { Todo } from '../../shared/types'

interface TasksViewProps {
  rootPath: string
}

const ACTIVITY_LABEL: Record<string, string> = {
  off: 'Off',
  resting: 'Resting',
  observing: 'Looking around…',
  working: 'Working',
  paused: 'Paused',
}

export const TasksView: React.FC<TasksViewProps> = ({ rootPath }) => {
  const wsId = useAppStore((s) => s.selectedWorkspaceId)
  const todos = useTodosStore((s) => s.todosByRoot[rootPath])
  const loadTodos = useTodosStore((s) => s.loadTodos)
  const addTodo = useTodosStore((s) => s.addTodo)
  const pet = usePetWs(wsId)

  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (rootPath) void loadTodos(rootPath)
  }, [rootPath, loadTodos])

  if (!rootPath || !wsId) {
    return (
      <div className="flex flex-col h-full">
        <SidebarSectionHeader title="Tasks" />
        <div className="flex flex-col items-center justify-center flex-1 text-muted text-xs gap-3 p-4">
          <span>No folder open</span>
        </div>
      </div>
    )
  }

  const list = todos ?? []
  const byStatus = (s: Todo['status']) => list.filter((t) => t.status === s)
  const suggested = byStatus('suggested')
  const inProgress = byStatus('in_progress')
  const review = byStatus('review')
  const pending = byStatus('pending')
  const history = list.filter((t) => t.status === 'done' || t.status === 'failed')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    addTodo(rootPath, draft)
    setDraft('')
  }

  // --- pet header controls ---
  const petControls = pet.enabled ? (
    <>
      <SidebarHeaderButton
        onClick={() => (pet.paused ? petController.resume(wsId, rootPath) : petController.pause(wsId, rootPath))}
        title={pet.paused ? 'Resume pet' : 'Pause pet'}
      >
        {pet.paused ? <ArrowsClockwise size={13} /> : <Pause size={13} />}
      </SidebarHeaderButton>
      <SidebarHeaderButton onClick={() => petController.dismiss(wsId, rootPath)} title="Dismiss pet">
        <X size={13} />
      </SidebarHeaderButton>
    </>
  ) : (
    <SidebarHeaderButton onClick={() => void petController.summon(wsId, rootPath)} title="Summon the Canvas Pet">
      <Sparkle size={13} />
    </SidebarHeaderButton>
  )

  return (
    <div className="flex flex-col h-full">
      <SidebarSectionHeader title="Tasks" actions={petControls} />

      {pet.enabled && (
        <div className="flex items-center gap-1.5 px-3 pb-1 text-[11px] text-muted select-none">
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              pet.activity === 'working'
                ? 'bg-green-400'
                : pet.activity === 'observing'
                  ? 'bg-blue-400'
                  : pet.activity === 'paused'
                    ? 'bg-amber-400'
                    : 'bg-muted/50'
            }`}
          />
          <span className="truncate">{pet.status || ACTIVITY_LABEL[pet.activity] || 'Pet'}</span>
        </div>
      )}

      <form onSubmit={submit} className="flex items-center gap-1.5 px-3 pb-2 pt-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a task…"
          className="flex-1 min-w-0 bg-surface-5 text-secondary text-[13px] rounded px-2 py-1 outline-none focus:ring-1 focus:ring-blue-500/50 placeholder:text-muted"
        />
        <button
          type="submit"
          title="Add task"
          disabled={!draft.trim()}
          className="flex-shrink-0 flex items-center justify-center w-[24px] h-[24px] rounded text-secondary hover:text-primary hover:bg-hover transition-colors disabled:opacity-30"
        >
          <Plus size={14} />
        </button>
      </form>

      <div className="flex-1 overflow-y-auto pb-2">
        {list.length === 0 && (
          <div className="flex flex-col items-center justify-center text-muted text-xs gap-2 pt-10">
            <ListChecks size={22} className="opacity-50" />
            <span>No tasks yet</span>
            {!pet.enabled && (
              <button
                onClick={() => void petController.summon(wsId, rootPath)}
                className="mt-1 flex items-center gap-1.5 px-2.5 py-1 rounded text-secondary hover:text-primary bg-surface-5 hover:bg-hover transition-colors"
              >
                <Sparkle size={12} /> Summon pet
              </button>
            )}
          </div>
        )}

        <GroupLabel show={suggested.length > 0} text="Suggested" />
        {suggested.map((t) => (
          <TodoRow key={t.id} todo={t} wsId={wsId} rootPath={rootPath} />
        ))}

        <GroupLabel show={inProgress.length > 0} text="In progress" />
        {inProgress.map((t) => (
          <TodoRow key={t.id} todo={t} wsId={wsId} rootPath={rootPath} />
        ))}

        <GroupLabel show={review.length > 0} text="Review" />
        {review.map((t) => (
          <TodoRow key={t.id} todo={t} wsId={wsId} rootPath={rootPath} />
        ))}

        <GroupLabel show={pending.length > 0} text="To do" />
        {pending.map((t) => (
          <TodoRow key={t.id} todo={t} wsId={wsId} rootPath={rootPath} />
        ))}

        <GroupLabel show={history.length > 0} text="Done" />
        {history.map((t) => (
          <TodoRow key={t.id} todo={t} wsId={wsId} rootPath={rootPath} />
        ))}
      </div>
    </div>
  )
}

// --- rows -------------------------------------------------------------------

const GroupLabel: React.FC<{ show: boolean; text: string }> = ({ show, text }) =>
  show ? (
    <div className="px-3 pt-3 pb-1 text-[11px] uppercase tracking-wide text-muted select-none">{text}</div>
  ) : null

const RowShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="group px-3 py-1.5 hover:bg-hover transition-colors">{children}</div>
)

const actionBtn = 'flex items-center gap-1 px-2 py-0.5 rounded text-[11.5px] transition-colors disabled:opacity-40'

/** The left-edge status control: an interactive checkbox for pending todos, a
 *  status icon for everything else. Same footprint across statuses so rows line
 *  up like a single uniform list. */
const StatusGlyph: React.FC<{ todo: Todo; onToggle: () => void }> = ({ todo, onToggle }) => {
  const base = 'mt-[2px] flex-shrink-0'
  switch (todo.status) {
    case 'pending':
      return (
        <button
          onClick={onToggle}
          title="Mark as done"
          className={`${base} flex items-center justify-center w-[15px] h-[15px] rounded-[4px] border border-subtle hover:border-secondary text-transparent hover:text-secondary transition-colors`}
        >
          <Check size={11} weight="bold" />
        </button>
      )
    case 'suggested':
      return <Sparkle size={13} weight="fill" className={`${base} text-blue-400`} />
    case 'in_progress':
      return <CircleNotch size={13} className={`${base} text-green-400 animate-spin`} />
    case 'review':
      return <GitMerge size={13} className={`${base} text-amber-400`} />
    case 'failed':
      return <X size={13} className={`${base} text-red-400/70`} />
    default: // done
      return <Check size={13} weight="bold" className={`${base} text-green-500/70`} />
  }
}

/** One uniform, fully-collapsible todo row. Collapsed it shows only the status
 *  glyph + title; expanding reveals the rationale/note and the status-specific
 *  actions. Self-contained so the list can render any status identically. */
const TodoRow: React.FC<{ todo: Todo; wsId: string; rootPath: string }> = ({ todo, wsId, rootPath }) => {
  const toggleTodo = useTodosStore((s) => s.toggleTodo)
  const removeTodo = useTodosStore((s) => s.removeTodo)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const runReview = async (fn: (w: string, r: string, t: Todo) => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn(wsId, rootPath, todo)
    } finally {
      setBusy(false)
    }
  }

  const currentStep = todo.plan?.find((s) => !s.done)?.title
  const terminalId = todo.terminalNodeIds?.[todo.terminalNodeIds.length - 1]
  const done = todo.status === 'done'
  const titleColor = done ? 'text-muted line-through' : todo.status === 'failed' ? 'text-muted' : 'text-secondary'

  const actions = (() => {
    switch (todo.status) {
      case 'suggested':
        return (
          <>
            <button
              onClick={() => void petController.runTodo(wsId, rootPath, todo.id)}
              className={`${actionBtn} text-white bg-blue-500 hover:bg-blue-600`}
            >
              <Play size={10} weight="fill" /> Approve & run
            </button>
            <button
              onClick={() => removeTodo(rootPath, todo.id)}
              className={`${actionBtn} text-muted hover:text-primary hover:bg-hover`}
            >
              Dismiss
            </button>
          </>
        )
      case 'in_progress':
        return terminalId ? (
          <button
            onClick={() => void revealPanel(wsId, terminalId, { retry: true })}
            className={`${actionBtn} text-muted hover:text-primary hover:bg-hover`}
          >
            <ArrowSquareOut size={11} /> Jump to terminal
          </button>
        ) : null
      case 'review':
        return (
          <>
            <button disabled={busy} onClick={() => void runReview(mergeTodo)} className={`${actionBtn} text-white bg-green-600 hover:bg-green-700`}>
              <GitMerge size={11} /> Merge
            </button>
            <button disabled={busy} onClick={() => void runReview(openPrTodo)} className={`${actionBtn} text-secondary hover:text-primary hover:bg-hover`}>
              <GitPullRequest size={11} /> PR
            </button>
            <button disabled={busy} onClick={() => void runReview(discardTodo)} className={`${actionBtn} text-muted hover:text-red-400 hover:bg-hover`}>
              <Trash size={11} /> Discard
            </button>
          </>
        )
      case 'pending':
        return (
          <>
            <button
              onClick={() => void petController.runTodo(wsId, rootPath, todo.id)}
              className={`${actionBtn} text-secondary hover:text-blue-400 hover:bg-hover`}
            >
              <Play size={11} /> Run
            </button>
            <button onClick={() => removeTodo(rootPath, todo.id)} className={`${actionBtn} text-muted hover:text-red-400 hover:bg-hover`}>
              <X size={11} /> Delete
            </button>
          </>
        )
      default: // done / failed
        return (
          <button onClick={() => removeTodo(rootPath, todo.id)} className={`${actionBtn} text-muted hover:text-primary hover:bg-hover`}>
            <Trash size={11} /> Remove
          </button>
        )
    }
  })()

  return (
    <RowShell>
      <div className="flex items-start gap-2">
        <StatusGlyph todo={todo} onToggle={() => toggleTodo(rootPath, todo.id)} />
        <div className="flex-1 min-w-0">
          <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-1 text-left">
            <span className={`flex-1 min-w-0 text-[13px] leading-snug ${open ? 'break-words' : 'truncate'} ${titleColor}`}>
              {todo.title}
            </span>
            <CaretRight
              size={11}
              className={`flex-shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`}
            />
          </button>

          {open && (
            <div className="mt-1 space-y-1">
              {todo.branch && <div className="text-[11px] text-muted truncate font-mono">{todo.branch}</div>}
              {currentStep && todo.status === 'in_progress' && <div className="text-[11.5px] text-muted">→ {currentStep}</div>}
              {todo.note && (
                <div className={`text-[11.5px] leading-snug break-words ${todo.status === 'review' ? 'text-amber-400/90' : 'text-muted'}`}>
                  {todo.note}
                </div>
              )}
              {actions && <div className="flex flex-wrap items-center gap-1.5 pt-0.5">{actions}</div>}
            </div>
          )}
        </div>
      </div>
    </RowShell>
  )
}
