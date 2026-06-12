// =============================================================================
// petTools — the fulfilment side of the cate-pet-tools extension. Each pet tool
// call arrives here (via petBridge) as {tool, params} with the calling session's
// PetContext, and is carried out against the live renderer stores + IPC APIs:
// terminals become visible canvas nodes, worktrees get registered (and rendered
// as colored territory), todos are mutated and persisted.
//
// Every handler returns a model-readable string (JSON for structured results,
// prose for output) which the extension surfaces verbatim as the tool result.
// =============================================================================

import { useAppStore, pickWorktreeColor } from '../stores/appStore'
import { useTodosStore } from '../stores/todosStore'
import { useStatusStore } from '../stores/statusStore'
import { gitStatusStore } from '../stores/gitStatusStore'
import { usePetStore } from './petStore'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { generateId } from '../stores/canvas/helpers'
import { getWorkspaceCanvasStore } from '../lib/workspace/canvasAccess'
import { viewToCanvas } from '../lib/canvas/coordinates'
import type { Todo, TodoStatus, WorktreeMeta, Point, AgentState } from '../../shared/types'
import type { PetContext } from './petTypes'
import { getExitCode, clearExit } from './petTerminalExits'
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

/** Resolve the ptyId for a terminal handle (the handle IS the panelId). */
function ptyFor(panelId: string): string | undefined {
  return terminalRegistry.ptyIdForPanel(panelId) ?? undefined
}

/** Compute an EXPLICIT canvas-space position for a pet terminal so it auto-places
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

/** True when the terminal panel is a live node on the workspace's canvas (so the
 *  world avatar can actually tether to it). Docked / detached terminals have no
 *  canvas node — the pet stays in its corner for those. */
function terminalOnCanvas(wsId: string, panelId: string): boolean {
  const store = getWorkspaceCanvasStore(wsId)
  if (!store) return false
  return Object.values(store.getState().nodes).some((n) => n.panelId === panelId)
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

// --- tool dispatch ----------------------------------------------------------

export async function runPetTool(ctx: PetContext, tool: string, params: Record<string, unknown>): Promise<string> {
  const { rootPath, workspaceId: wsId } = ctx
  const todos = useTodosStore.getState()

  switch (tool) {
    // --- shared ---
    case 'list_todos': {
      const list = todos.getTodos(rootPath).map((t) => ({
        id: t.id,
        title: t.title,
        origin: t.origin,
        status: t.status,
        note: t.note,
      }))
      return json({ todos: list })
    }

    case 'read_terminal': {
      const terminalId = String(params.terminalId ?? '')
      // Sit the pet on whatever it's currently reading, so the observer visibly
      // moves to the terminal it's inspecting (only if that terminal is on canvas).
      if (terminalId && terminalOnCanvas(wsId, terminalId)) {
        usePetStore.getState().patch(wsId, { focusNodeId: terminalId })
      }
      return json(await readTerminalState(wsId, terminalId))
    }

    // --- observer ---
    case 'get_user_activity': {
      const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
      const panels = ws ? Object.values(ws.panels).map((p) => ({ type: p.type, title: p.title })) : []
      let changed: string[] = []
      let branch: string | null = null
      try {
        const status = await window.electronAPI.gitStatus(rootPath)
        branch = status.current
        changed = status.files.slice(0, 40).map((f) => f.path)
      } catch {
        /* not a git repo / unavailable */
      }
      return json({ branch, openPanels: panels, changedFiles: changed })
    }

    case 'list_terminals': {
      const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
      const wsStatus = useStatusStore.getState().workspaces[wsId]
      const terminals = ws
        ? Object.values(ws.panels)
            .filter((p) => p.type === 'terminal')
            .map((p) => {
              const ptyId = ptyFor(p.id)
              const running = ptyId ? activityRunning(wsId, ptyId) : false
              return { terminalId: p.id, title: p.title, busy: running }
            })
        : []
      void wsStatus
      return json({ terminals })
    }

    case 'propose_todo': {
      const title = String(params.title ?? '').trim()
      const rationale = String(params.rationale ?? '').trim()
      if (!title) return json({ ok: false, error: 'title is required' })
      const now = Date.now()
      const todo: Todo = {
        id: generateId(),
        title,
        origin: 'pet',
        status: 'suggested',
        createdAt: now,
        updatedAt: now,
        note: rationale || undefined,
      }
      todos.upsertTodo(rootPath, todo)
      return json({ ok: true, id: todo.id })
    }

    // --- executor ---
    case 'create_worktree': {
      const todoId = String(params.todoId ?? ctx.todoId ?? '')
      const todo = todoById(rootPath, todoId)
      if (!todo) return json({ ok: false, error: `no todo ${todoId}` })
      if (todo.worktreeId && worktreeMetaFor(wsId, todo.worktreeId)) {
        const meta = worktreeMetaFor(wsId, todo.worktreeId) as WorktreeMeta
        return json({ ok: true, worktreeId: meta.id, branch: todo.branch, path: meta.path, reused: true })
      }
      const branch = `pet/${toBranchName(todo.title)}`
      const targetPath = worktreePathFor(rootPath, branch)
      try {
        await window.electronAPI.gitWorktreeAdd(rootPath, branch, targetPath, { createBranch: true })
      } catch (err) {
        return json({ ok: false, error: `worktree add failed: ${err instanceof Error ? err.message : String(err)}` })
      }
      const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
      const meta: WorktreeMeta = {
        id: `wt-${generateId()}`,
        path: targetPath,
        label: todo.title.slice(0, 40),
        color: pickWorktreeColor(ws?.worktrees ?? []),
      }
      useAppStore.getState().upsertWorktree(wsId, meta)
      useAppStore.getState().addAdditionalRoot(wsId, targetPath)
      todos.patchTodo(rootPath, todoId, { worktreeId: meta.id, branch, status: 'in_progress' })
      gitStatusStore.refresh(rootPath)
      return json({ ok: true, worktreeId: meta.id, branch, path: targetPath })
    }

    case 'set_plan': {
      const todoId = String(params.todoId ?? ctx.todoId ?? '')
      const rawSteps = Array.isArray(params.steps) ? (params.steps as Array<Record<string, unknown>>) : []
      const steps = rawSteps
        .filter((s) => typeof s?.title === 'string')
        .map((s) => ({ title: String(s.title), done: !!s.done }))
      if (steps.length === 0) return json({ ok: false, error: 'steps required' })
      todos.setTodoPlan(rootPath, todoId, steps)
      return json({ ok: true, steps: steps.length })
    }

    case 'create_terminal': {
      const todoId = String(params.todoId ?? ctx.todoId ?? '')
      const command = String(params.command ?? '')
      const todo = todoById(rootPath, todoId)
      if (!todo?.worktreeId) return json({ ok: false, error: 'call create_worktree first' })
      const meta = worktreeMetaFor(wsId, todo.worktreeId)
      if (!meta) return json({ ok: false, error: 'worktree not found' })

      const app = useAppStore.getState()
      // Explicit position → silent auto-place (no interactive ghost prompt).
      const priorCount = todoById(rootPath, todoId)?.terminalNodeIds?.length ?? 0
      const pos = terminalPosition(wsId, priorCount)
      const panelId = app.createTerminal(wsId, undefined, pos, { target: 'canvas' }, meta.path)
      app.setPanelWorktreeId(wsId, panelId, todo.worktreeId)
      // Track the terminal on the todo so the avatar + cleanup can find it, and
      // point the avatar at it (it tethers to this terminal while working).
      const existing = todoById(rootPath, todoId)?.terminalNodeIds ?? []
      todos.patchTodo(rootPath, todoId, { terminalNodeIds: [...existing, panelId] })
      usePetStore.getState().patch(wsId, { focusNodeId: panelId })

      const ptyId = await waitForPty(panelId)
      if (!ptyId) return json({ ok: true, terminalId: panelId, warning: 'terminal not ready; command not sent yet' })
      try {
        await window.electronAPI.shellRegisterTerminal(ptyId)
      } catch {
        /* activity polling is best-effort */
      }
      if (command.trim()) {
        await window.electronAPI.terminalWrite(ptyId, command + '\r')
      }
      return json({ ok: true, terminalId: panelId })
    }

    case 'send_keys': {
      const terminalId = String(params.terminalId ?? '')
      const keys = String(params.keys ?? '')
      const enter = params.enter !== false
      const ptyId = ptyFor(terminalId)
      if (!ptyId) return json({ ok: false, error: 'terminal not found / not ready' })
      await window.electronAPI.terminalWrite(ptyId, enter ? keys + '\r' : keys)
      return json({ ok: true })
    }

    case 'wait_for_terminal': {
      const terminalId = String(params.terminalId ?? '')
      const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 120_000
      const ptyId = ptyFor(terminalId)
      if (!ptyId) return json({ ok: false, error: 'terminal not found / not ready' })
      const start = Date.now()
      // Give the command a beat to actually start before we sample state.
      await sleep(600)
      let timedOut = false
      while (true) {
        if (getExitCode(ptyId) !== null) break // process exited
        const aState = agentStateFor(wsId, ptyId)
        if (aState) {
          // A coding-agent CLI is running here. It stays foreground the whole
          // session (so shell "idle" never fires), so its OWN turn-state is the
          // signal: a turn is done once it parks at waitingForInput / finished.
          if (aState === 'waitingForInput' || aState === 'finished' || aState === 'notRunning') break
        } else if (!activityRunning(wsId, ptyId)) {
          break // plain command: the shell went idle
        }
        if (Date.now() - start > timeoutMs) {
          timedOut = true
          break
        }
        await sleep(500)
      }
      const state = await readTerminalState(wsId, terminalId)
      return json({ ...state, timedOut })
    }

    case 'close_terminal': {
      const terminalId = String(params.terminalId ?? '')
      const ptyId = ptyFor(terminalId)
      try {
        useAppStore.getState().closePanel(wsId, terminalId)
      } catch (err) {
        log.warn('[petTools] close_terminal failed: %O', err)
      }
      if (ptyId) clearExit(ptyId)
      return json({ ok: true })
    }

    case 'update_todo': {
      const todoId = String(params.todoId ?? ctx.todoId ?? '')
      const patch: Partial<Todo> = {}
      if (typeof params.status === 'string') patch.status = params.status as TodoStatus
      if (typeof params.note === 'string') patch.note = params.note
      if (Object.keys(patch).length === 0) return json({ ok: false, error: 'nothing to update' })
      todos.patchTodo(rootPath, todoId, patch)
      return json({ ok: true })
    }

    default:
      return json({ ok: false, error: `unknown tool ${tool}` })
  }
}
