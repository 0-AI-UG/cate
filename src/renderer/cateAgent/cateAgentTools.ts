// =============================================================================
// cateAgentTools — the fulfilment side of the cate-agent-tools extension. Each
// Cate Agent tool call arrives here (via cateAgentBridge) as {tool, params} with
// the calling session's CateAgentContext, and is carried out against the live
// renderer stores + IPC APIs: terminals become visible canvas nodes, worktrees
// get registered (and rendered as colored territory), todos are mutated and
// persisted.
//
// Every handler returns a model-readable string (JSON for structured results,
// prose for output) which the extension surfaces verbatim as the tool result.
// =============================================================================

import { useAppStore, pickWorktreeColor } from '../stores/appStore'
import { useTodosStore } from '../stores/todosStore'
import { useStatusStore } from '../stores/statusStore'
import { gitStatusStore } from '../stores/gitStatusStore'
import { useCateAgentStore } from './cateAgentStore'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { generateId } from '../stores/canvas/helpers'
import { getWorkspaceCanvasStore } from '../lib/workspace/canvasAccess'
import { viewToCanvas } from '../lib/canvas/coordinates'
import type { Todo, TodoStatus, WorktreeMeta, Point, AgentState } from '../../shared/types'
import type { CateAgentContext } from './cateAgentTypes'
import { getExitCode, clearExit } from './cateAgentTerminalExits'
import log from '../lib/logger'

const json = (v: unknown): string => JSON.stringify(v)

// --- helpers ----------------------------------------------------------------

function todoById(rootPath: string, id: string): Todo | undefined {
  return useTodosStore.getState().getTodos(rootPath).find((t) => t.id === id)
}

function worktreePathFor(repoRoot: string, branch: string): string {
  const trimmed = repoRoot.replace(/[/\\]+$/, '')
  const slug = branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'wt'
  return `${trimmed}/.cate/worktrees/${slug}`
}

function toBranchName(input: string): string {
  return (
    input
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w./-]+/g, '')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 60) || 'task'
  )
}

function worktreeMetaFor(wsId: string, worktreeId: string): WorktreeMeta | undefined {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
  return ws?.worktrees?.find((w) => w.id === worktreeId)
}

/** Deterministically ensure a todo's isolated git worktree exists, BEFORE the
 *  executor session runs. Idempotent — a todo that already has a worktree reuses
 *  it, so a todo only ever gets ONE. Non-git workspaces get no worktree (the
 *  feature still runs; terminals just use the repo root). Returns the cwd the
 *  todo's terminals should run in and the worktree id (null when none). */
export async function ensureTodoWorktree(
  wsId: string,
  rootPath: string,
  todoId: string,
): Promise<{ worktreeId: string | null; cwd: string }> {
  const todo = todoById(rootPath, todoId)
  if (!todo) return { worktreeId: null, cwd: rootPath }
  // User chose "No worktree" — run straight in the project root, no isolation.
  if (todo.noWorktree) return { worktreeId: null, cwd: rootPath }
  // Reuse an already-created worktree — the single guarantee of one-per-todo.
  if (todo.worktreeId) {
    const meta = worktreeMetaFor(wsId, todo.worktreeId)
    if (meta) return { worktreeId: meta.id, cwd: meta.path }
  }
  // Only git repos can have worktrees; everything else runs in the repo root.
  let isRepo = false
  try {
    isRepo = await window.electronAPI.gitIsRepo(rootPath)
  } catch {
    isRepo = false
  }
  if (!isRepo) return { worktreeId: null, cwd: rootPath }

  // Name the worktree from the short derived topic when the executor has set it
  // (it calls set_topic before opening any terminal, which is when we get here),
  // falling back to the prompt only when there is no topic yet. Keeps the branch
  // + pill short instead of echoing the whole user prompt.
  const nameSource = todo.topic?.trim() || todo.title
  const branch = `cate-agent/${toBranchName(nameSource)}`
  const targetPath = worktreePathFor(rootPath, branch)
  try {
    await window.electronAPI.gitWorktreeAdd(rootPath, branch, targetPath, { createBranch: true })
  } catch (err) {
    log.warn('[cateAgentTools] worktree add failed for %s: %O', todoId, err)
    return { worktreeId: null, cwd: rootPath }
  }
  const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
  const meta: WorktreeMeta = {
    id: `wt-${generateId()}`,
    path: targetPath,
    label: nameSource.slice(0, 40),
    color: pickWorktreeColor(ws?.worktrees ?? []),
  }
  useAppStore.getState().upsertWorktree(wsId, meta)
  useAppStore.getState().addAdditionalRoot(wsId, targetPath)
  useTodosStore.getState().patchTodo(rootPath, todoId, { worktreeId: meta.id, branch })
  gitStatusStore.refresh(rootPath)
  return { worktreeId: meta.id, cwd: targetPath }
}

/** Surface a short FYI from the Cate Agent into the persistent feedback log shown
 *  above the toolbar. */
function setRemark(wsId: string, text: string): void {
  useCateAgentStore.getState().appendFeed(wsId, 'agent', text)
}

/** Resolve the ptyId for a terminal handle (the handle IS the panelId). */
function ptyFor(panelId: string): string | undefined {
  return terminalRegistry.ptyIdForPanel(panelId) ?? undefined
}

/** Close ANY canvas panel (terminal or otherwise) through the single disposal
 *  path, and clean up the per-terminal bookkeeping (glow set + exit tracking)
 *  when it happens to be a terminal. Shared by close_terminal and close_panel. */
function closeCanvasPanel(wsId: string, panelId: string): void {
  const ptyId = ptyFor(panelId)
  try {
    useAppStore.getState().closePanel(wsId, panelId)
  } catch (err) {
    log.warn('[cateAgentTools] closePanel failed: %O', err)
  }
  useCateAgentStore.getState().removeControlledTerminal(wsId, panelId)
  if (ptyId) clearExit(ptyId)
}

/** Compute an EXPLICIT canvas-space position for a Cate Agent terminal so it auto-places
 *  silently — never triggering the interactive "click to place" ghost (which is
 *  what fires when a canvas panel is created with no position and the placement
 *  picker is on). Anchors near the viewport center and cascades per terminal so
 *  a todo's terminals tile instead of stacking exactly. */
function terminalPosition(wsId: string, index: number): Point | undefined {
  const store = getWorkspaceCanvasStore(wsId)
  if (!store) return undefined // no canvas → panel docks (no ghost), leave undefined
  const s = store.getState()
  const center = { x: s.containerSize.width / 2, y: s.containerSize.height / 2 }
  const canvasCenter = viewToCanvas(center, s.zoomLevel, s.viewportOffset)
  // Top-left so the first lands roughly centered; cascade down-right after that.
  const step = 40
  return { x: canvasCenter.x - 240 + index * step, y: canvasCenter.y - 170 + index * step }
}

function activityRunning(wsId: string, ptyId: string): boolean {
  const act = useStatusStore.getState().workspaces[wsId]?.terminalActivity[ptyId]
  return act?.type === 'running'
}

/** The coding-agent turn-state for a terminal (running / waitingForInput /
 *  finished / notRunning), or null when no known agent CLI is in it. Set by
 *  agentScreenDetector and the single reliable "the agent finished its turn"
 *  signal for a long-lived TUI agent that never exits between prompts. */
function agentStateFor(wsId: string, ptyId: string): AgentState | null {
  return useStatusStore.getState().workspaces[wsId]?.agentState[ptyId] ?? null
}

/** Read a terminal's CURRENT RENDERED SCREEN as plain text from its live xterm
 *  buffer — what the user actually sees. We deliberately do NOT read the raw PTY
 *  log here: TUI coding agents (claude, codex) repaint via cursor-move escapes,
 *  so the append-only log is unreadable redraw spam, whereas xterm's buffer is
 *  the clean, de-duplicated screen. Returns null when the terminal isn't mounted
 *  (e.g. detached), so the caller can fall back to the log. */
function readScreenText(panelId: string, maxLines = 200): string | null {
  const entry = terminalRegistry.getEntry(panelId)
  if (!entry) return null
  const buf = entry.terminal.buffer.active
  const total = buf.length
  const start = Math.max(0, total - maxLines)
  const lines: string[] = []
  for (let i = start; i < total; i++) {
    const line = buf.getLine(i)
    lines.push(line ? line.translateToString(true) : '')
  }
  return lines.join('\n').replace(/\n+$/, '')
}

async function readTerminalState(
  wsId: string,
  panelId: string,
): Promise<{ output: string; isRunning: boolean; lastExitCode: number | null; agentState: AgentState | null }> {
  const ptyId = ptyFor(panelId)
  if (!ptyId) return { output: '', isRunning: false, lastExitCode: null, agentState: null }
  let output = readScreenText(panelId)
  if (output === null) {
    // Terminal not mounted — fall back to the raw log, tailed so a long build
    // doesn't blow the result up.
    try {
      const raw = (await window.electronAPI.terminalLogRead(ptyId)) ?? ''
      output = raw.length > 6000 ? raw.slice(-6000) : raw
    } catch {
      output = ''
    }
  }
  return {
    output,
    isRunning: activityRunning(wsId, ptyId),
    lastExitCode: getExitCode(ptyId),
    agentState: agentStateFor(wsId, ptyId),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Wait until a freshly created panel has a live pty, or give up. */
async function waitForPty(panelId: string, timeoutMs = 8000): Promise<string | undefined> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ptyId = ptyFor(panelId)
    if (ptyId) return ptyId
    await sleep(120)
  }
  return ptyFor(panelId)
}

/** Snapshot of the workspace the observer needs every turn — activity, terminals,
 *  and todos — built from the live stores and injected into the observe prompt so
 *  the agent doesn't burn tool round-trips rediscovering known state. It still
 *  calls read_terminal to look closely at a terminal it picks from this list. */
export async function buildObserveContext(wsId: string, rootPath: string): Promise<string> {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
  const panels = ws ? Object.values(ws.panels) : []
  const openPanels = panels.map((p) => ({ type: p.type, title: p.title }))
  const terminals = panels
    .filter((p) => p.type === 'terminal')
    .map((p) => {
      const ptyId = ptyFor(p.id)
      return { terminalId: p.id, title: p.title, busy: ptyId ? activityRunning(wsId, ptyId) : false }
    })
  let branch: string | null = null
  let changedFiles: string[] = []
  try {
    const status = await window.electronAPI.gitStatus(rootPath)
    branch = status.current
    changedFiles = status.files.slice(0, 40).map((f) => f.path)
  } catch {
    /* not a git repo / unavailable */
  }
  const todoList = useTodosStore.getState().getTodos(rootPath).map((t) => ({ id: t.id, title: t.title, status: t.status }))
  return json({ branch, changedFiles, openPanels, terminals, todos: todoList })
}

// --- executor wait/wake -----------------------------------------------------

/** True while a terminal is doing work — a coding-agent CLI mid-turn or a live
 *  shell command. Parked (waitingForInput/finished), exited, or idle => NOT busy,
 *  i.e. it needs the orchestrator's attention. */
function terminalBusy(wsId: string, panelId: string): boolean {
  const ptyId = ptyFor(panelId)
  if (!ptyId) return false
  if (getExitCode(ptyId) !== null) return false
  const aState = agentStateFor(wsId, ptyId)
  if (aState) return aState === 'running'
  return activityRunning(wsId, ptyId)
}

/** Any of this todo's terminals still working — so the executor should yield and
 *  be woken on a terminal event rather than continued in a fresh session. */
export function todoHasBusyTerminal(wsId: string, rootPath: string, todoId: string): boolean {
  const todo = todoById(rootPath, todoId)
  return (todo?.terminalNodeIds ?? []).some((p) => terminalBusy(wsId, p))
}

/** Safety cap on a single yield — bounds a genuinely long command and backstops
 *  any terminal transition the activity poller misses. */
const WAKE_TIMEOUT_MS = 5 * 60_000

/** Resolve once any of the todo's currently-busy terminals stops being busy (a
 *  driven CLI parks at waitingForInput/finished, or a command exits), or the
 *  safety timeout elapses. This is what lets the executor yield its turn while
 *  several CLIs work in parallel instead of blocking on one: the controller
 *  awaits this and re-wakes the executor when a terminal needs attention. */
export function waitForTerminalSignal(wsId: string, rootPath: string, todoId: string): Promise<void> {
  const todo = todoById(rootPath, todoId)
  const busyNow = (todo?.terminalNodeIds ?? []).filter((p) => terminalBusy(wsId, p))
  return new Promise((resolve) => {
    if (busyNow.length === 0) {
      resolve()
      return
    }
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      unsub()
      clearTimeout(timer)
      resolve()
    }
    // statusStore updates on every activity / agent-state poll, so re-checking on
    // each change catches a terminal parking or exiting; the timeout backstops
    // anything polling misses (and bounds a genuinely long-running command).
    const unsub = useStatusStore.subscribe(() => {
      if (busyNow.some((p) => !terminalBusy(wsId, p))) finish()
    })
    const timer = setTimeout(finish, WAKE_TIMEOUT_MS)
  })
}

/** Compact status of every terminal the todo is driving — injected into the wake
 *  prompt so the executor sees which CLIs parked/exited without rediscovering
 *  them. It still read_terminal's the ones it wants a closer look at. */
export function buildExecutorContext(wsId: string, rootPath: string, todoId: string): string {
  const todo = todoById(rootPath, todoId)
  const terminals = (todo?.terminalNodeIds ?? []).map((panelId) => {
    const ptyId = ptyFor(panelId)
    return {
      terminalId: panelId,
      busy: terminalBusy(wsId, panelId),
      agentState: ptyId ? agentStateFor(wsId, ptyId) : null,
      lastExitCode: ptyId ? getExitCode(ptyId) : null,
    }
  })
  return json({ terminals })
}

/** Default inline wait (ms) for a foreground create_terminal/send_keys — long
 *  enough for a coding-agent CLI turn, bounded so a hung command can't lock the
 *  executor forever. The agent opts out of waiting entirely with background:true. */
const ACTION_WAIT_MS = 5 * 60_000

/** Wait inline until a terminal's current work settles — a coding-agent CLI parks
 *  (waitingForInput/finished), a plain command's shell goes idle, or the process
 *  exits — or the timeout elapses, then return its screen + state. This is what
 *  makes waiting the DEFAULT for create_terminal/send_keys. */
async function waitForTerminalIdle(
  wsId: string,
  panelId: string,
): Promise<{ output: string; isRunning: boolean; lastExitCode: number | null; agentState: AgentState | null; timedOut: boolean }> {
  const ptyId = ptyFor(panelId)
  if (!ptyId) return { output: '', isRunning: false, lastExitCode: null, agentState: null, timedOut: false }
  const start = Date.now()
  await sleep(600) // let the command actually start before sampling
  let timedOut = false
  while (true) {
    if (getExitCode(ptyId) !== null) break // process exited
    const aState = agentStateFor(wsId, ptyId)
    if (aState) {
      // A coding-agent CLI stays foreground, so its OWN turn-state is the signal.
      if (aState === 'waitingForInput' || aState === 'finished' || aState === 'notRunning') break
    } else if (!activityRunning(wsId, ptyId)) {
      break // plain command: the shell went idle
    }
    if (Date.now() - start > ACTION_WAIT_MS) {
      timedOut = true
      break
    }
    await sleep(500)
  }
  return { ...(await readTerminalState(wsId, panelId)), timedOut }
}

// --- tool dispatch ----------------------------------------------------------

export async function runCateAgentTool(ctx: CateAgentContext, tool: string, params: Record<string, unknown>): Promise<string> {
  const { rootPath, workspaceId: wsId } = ctx
  const todos = useTodosStore.getState()

  switch (tool) {
    // --- shared ---
    case 'read_terminal': {
      const terminalId = String(params.terminalId ?? '')
      return json(await readTerminalState(wsId, terminalId))
    }

    // --- observer ---
    case 'propose_todo': {
      const title = String(params.title ?? '').trim()
      const rationale = String(params.rationale ?? '').trim()
      if (!title) return json({ ok: false, error: 'title is required' })
      const now = Date.now()
      const todo: Todo = {
        id: generateId(),
        title,
        origin: 'cateAgent',
        status: 'suggested',
        createdAt: now,
        updatedAt: now,
        note: rationale || undefined,
      }
      todos.upsertTodo(rootPath, todo)
      // A new proposal is unseen activity when the panel is closed → toolbar dot.
      if (!useCateAgentStore.getState().get(wsId).inputOpen) useCateAgentStore.getState().setUnseen(wsId, true)
      return json({ ok: true, id: todo.id })
    }

    case 'remark': {
      const text = String(params.text ?? '').trim()
      if (!text) return json({ ok: false, error: 'text is required' })
      setRemark(wsId, text.slice(0, 200))
      return json({ ok: true })
    }

    // --- executor ---
    case 'create_terminal': {
      const todoId = String(params.todoId ?? ctx.todoId ?? '')
      const command = String(params.command ?? '')
      const todo = todoById(rootPath, todoId)
      if (!todo) return json({ ok: false, error: `no todo ${todoId}` })
      // The worktree is created LAZILY — the first terminal a job opens is its
      // first real (code) work, so prepare the isolated worktree now. Idempotent:
      // later terminals reuse it. Non-git / "no worktree" jobs run in the repo root.
      const { worktreeId, cwd } = await ensureTodoWorktree(wsId, rootPath, todoId)
      const meta = worktreeId ? worktreeMetaFor(wsId, worktreeId) : undefined

      const app = useAppStore.getState()
      // Explicit position → silent auto-place (no interactive ghost prompt).
      const priorCount = todoById(rootPath, todoId)?.terminalNodeIds?.length ?? 0
      const pos = terminalPosition(wsId, priorCount)
      const panelId = app.createTerminal(wsId, undefined, pos, { target: 'canvas' }, cwd)
      if (worktreeId) app.setPanelWorktreeId(wsId, panelId, worktreeId)
      // Track the terminal on the todo so cleanup can find it.
      const existing = todoById(rootPath, todoId)?.terminalNodeIds ?? []
      todos.patchTodo(rootPath, todoId, { terminalNodeIds: [...existing, panelId] })
      // The executor is now driving this terminal — light it up (in the job's
      // worktree color, or the theme accent when it has no worktree) until the run ends.
      if (ctx.role === 'executor') {
        const glow = meta?.color ?? 'rgb(var(--agent-rgb))'
        useCateAgentStore.getState().addControlledTerminal(wsId, panelId, glow)
      }

      const ptyId = await waitForPty(panelId)
      if (!ptyId) return json({ ok: true, terminalId: panelId, warning: 'terminal not ready; command not sent yet' })
      try {
        await window.electronAPI.shellRegisterTerminal(ptyId)
      } catch {
        /* activity polling is best-effort */
      }
      const background = params.background === true
      if (command.trim()) {
        await window.electronAPI.terminalWrite(ptyId, command + '\r')
        // Wait for the command to finish by default; background:true returns now.
        if (!background) return json({ ok: true, terminalId: panelId, ...(await waitForTerminalIdle(wsId, panelId)) })
      }
      return json({ ok: true, terminalId: panelId })
    }

    case 'send_keys': {
      const terminalId = String(params.terminalId ?? '')
      const keys = String(params.keys ?? '')
      const enter = params.enter !== false
      const background = params.background === true
      const ptyId = ptyFor(terminalId)
      if (!ptyId) return json({ ok: false, error: 'terminal not found / not ready' })
      await window.electronAPI.terminalWrite(ptyId, enter ? keys + '\r' : keys)
      // Wait for the resulting work to finish by default; background:true returns now.
      if (background) return json({ ok: true })
      return json({ ok: true, ...(await waitForTerminalIdle(wsId, terminalId)) })
    }

    case 'list_terminals': {
      const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
      const terminals = (ws ? Object.values(ws.panels) : [])
        .filter((p) => p.type === 'terminal')
        .map((p) => {
          const ptyId = ptyFor(p.id)
          return { terminalId: p.id, title: p.title, busy: ptyId ? activityRunning(wsId, ptyId) : false }
        })
      return json({ terminals })
    }

    case 'list_panels': {
      const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
      const panels = (ws ? Object.values(ws.panels) : []).map((p) => ({ panelId: p.id, type: p.type, title: p.title }))
      return json({ panels })
    }

    case 'close_terminal': {
      const terminalId = String(params.terminalId ?? '')
      closeCanvasPanel(wsId, terminalId)
      return json({ ok: true })
    }

    case 'close_panel': {
      const panelId = String(params.panelId ?? '')
      if (!panelId) return json({ ok: false, error: 'panelId is required' })
      closeCanvasPanel(wsId, panelId)
      return json({ ok: true })
    }

    case 'focus_panel': {
      const panelId = String(params.panelId ?? '')
      if (!panelId) return json({ ok: false, error: 'panelId is required' })
      const store = getWorkspaceCanvasStore(wsId)
      if (!store) return json({ ok: false, error: 'no canvas in this workspace' })
      const s = store.getState()
      const nodeId = s.nodeForPanel(panelId)
      if (!nodeId) return json({ ok: false, error: `no canvas node for panel ${panelId}` })
      s.focusNode(nodeId)
      return json({ ok: true })
    }

    case 'set_topic': {
      const todoId = String(params.todoId ?? ctx.todoId ?? '')
      const topic = String(params.topic ?? '').trim()
      if (todoId && topic) {
        todos.patchTodo(rootPath, todoId, { topic: topic.slice(0, 60) })
        // If a worktree was already minted (a terminal opened before set_topic),
        // relabel its pill to the short topic too — the branch keeps its name.
        const wtId = todoById(rootPath, todoId)?.worktreeId
        const meta = wtId ? worktreeMetaFor(wsId, wtId) : undefined
        if (meta) useAppStore.getState().upsertWorktree(wsId, { ...meta, label: topic.slice(0, 40) })
      }
      return json({ ok: true })
    }

    case 'answer': {
      const todoId = String(params.todoId ?? ctx.todoId ?? '')
      const text = String(params.text ?? '').trim()
      if (!todoId || !text) return json({ ok: false, error: 'todoId and text are required' })
      // An answer is the user-facing result AND completes the job — a question or
      // read-only task has nothing to land, so it settles to `done` (never review).
      todos.patchTodo(rootPath, todoId, { output: text, status: 'done' })
      const title = todoById(rootPath, todoId)?.title ?? 'task'
      setRemark(wsId, `Answered: "${title}"`)
      return json({ ok: true })
    }

    case 'update_todo': {
      const todoId = String(params.todoId ?? ctx.todoId ?? '')
      const patch: Partial<Todo> = {}
      if (typeof params.status === 'string') patch.status = params.status as TodoStatus
      if (typeof params.note === 'string') patch.note = params.note
      if (Object.keys(patch).length === 0) return json({ ok: false, error: 'nothing to update' })
      // The review/land gate (merge / PR / discard) only exists for worktree-based
      // todos. A non-git todo has no branch to land — its work is already in the
      // project root — so it completes directly to `done`, never `review`.
      if (patch.status === 'review' && !todoById(rootPath, todoId)?.worktreeId) patch.status = 'done'
      todos.patchTodo(rootPath, todoId, patch)
      // Surface a settled todo in the feed (and flag the toolbar if the panel is
      // closed). Review needs the user's land decision; done/failed are outcomes.
      const title = todoById(rootPath, todoId)?.title ?? 'task'
      if (patch.status === 'review') setRemark(wsId, `Ready for review: "${title}"`)
      else if (patch.status === 'done') setRemark(wsId, `Done: "${title}"`)
      else if (patch.status === 'failed') setRemark(wsId, `Couldn't finish: "${title}"`)
      return json({ ok: true })
    }

    default:
      return json({ ok: false, error: `unknown tool ${tool}` })
  }
}
