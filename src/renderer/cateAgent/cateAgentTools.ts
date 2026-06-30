// =============================================================================
// cateAgentTools — the fulfilment side of the cate-agent-tools extension. Each
// Cate Agent tool call arrives here (via cateAgentBridge) as {tool, params} with
// the calling session's CateAgentContext, and is carried out against the live
// renderer stores + IPC APIs.
//
// The job model is loop-based:
//   - The ORCHESTRATOR (orchestrator role, read-only — no write/edit tools) sets a
//     goal + how to check it, then spawns parallel ITERATIONS. Each iterate creates
//     a fresh worktree and spawns ONE per-iteration DRIVER (via codingAgentLauncher)
//     seeded with the overview; that driver decides the agent decomposition, launches
//     the coding-agent CLIs, and drives them to completion. The orchestrator never
//     chooses agents and never edits files itself.
//   - Each iteration is CHECKED through a single-agent VERIFIER driver
//     (runIterationCheck): it runs the check in the worktree and writes a verdict to
//     `.cate/verdict.json`, which the controller reads back. The work driver never
//     grades its own output.
//
// Tool handlers only mutate todo/iteration state + drive terminals; all session
// lifecycle (running the checks, waking the orchestrator) lives in the controller,
// which observes this state on each yield. Every handler returns a model-readable
// string (JSON or prose) surfaced verbatim as the tool result.
//
// Terminal primitives live in cateAgentTerminals; the "run a driver to completion"
// primitive lives in codingAgentLauncher — both shared with this module.
// =============================================================================

import { useAppStore, pickWorktreeColor } from '../stores/appStore'
import { useTodosStore } from '../stores/todosStore'
import { gitStatusStore } from '../stores/gitStatusStore'
import { useCateAgentStore } from './cateAgentStore'
import { generateId } from '../stores/canvas/helpers'
import type {
  Todo,
  TodoStatus,
  WorktreeMeta,
  Iteration,
} from '../../shared/types'
import type { CateAgentContext } from './cateAgentTypes'
import {
  ptyFor,
  closeCanvasPanel,
  terminalBusy,
  readTerminalState,
  shortId,
} from './cateAgentTerminals'
import { runDriverToCompletion, openDriverTerminal, armBackgroundSend } from './codingAgentLauncher'
import { worktreeMetaFor, teardownWorktree } from './cateAgentWorktrees'
import log from '../lib/logger'

const json = (v: unknown): string => JSON.stringify(v)

/** Pause between writing send_keys text and the lone submit `\r`, so a TUI's
 *  bracketed-paste/burst detection sees the Enter as a discrete keypress (a submit)
 *  rather than a pasted newline. */
const SUBMIT_ENTER_DELAY_MS = 150

// --- helpers ----------------------------------------------------------------

function todoById(rootPath: string, id: string): Todo | undefined {
  return useTodosStore.getState().getTodos(rootPath).find((t) => t.id === id)
}

/** The agent is handed `shortId(...)` prefixes; recover the real id by prefix-
 *  matching the live candidate set. Falls through to the supplied string (so a
 *  bad/empty id still produces the natural "not found" error downstream). */
function resolveTerminalId(wsId: string, supplied: string): string {
  if (!supplied) return supplied
  const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
  const hit = ws && Object.values(ws.panels).find((p) => p.type === 'terminal' && p.id.startsWith(supplied))
  return hit ? hit.id : supplied
}

function resolveIterationId(rootPath: string, todoId: string, supplied: string): string {
  if (!supplied) return supplied
  const hit = todoById(rootPath, todoId)?.iterations?.find((i) => i.id.startsWith(supplied))
  return hit ? hit.id : supplied
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

/** Derive a short job topic from a prompt, deterministically (no model call).
 *  Used to title job cards and name worktree branches. */
export function deriveTopic(prompt: string): string {
  const oneLine = prompt.trim().replace(/\s+/g, ' ')
  const words = oneLine.split(' ')
  if (words.length <= 6 && oneLine.length <= 48) return oneLine
  const out: string[] = []
  for (const w of words) {
    if (out.length >= 6 || [...out, w].join(' ').length > 48) break
    out.push(w)
  }
  return out.join(' ') || oneLine.slice(0, 48)
}

async function isGitRepo(rootPath: string): Promise<boolean> {
  try {
    return await window.electronAPI.gitIsRepo(rootPath)
  } catch {
    return false
  }
}

/** Create a FRESH git worktree off `baseRef` (default HEAD), register it (colored
 *  territory + additional root), and return its handle. Returns null for non-git
 *  workspaces or on failure (the caller then falls back to the project root). The
 *  branch is `cate-agent/<slug>` with a unique id suffix so it never collides. */
export async function createWorktree(
  wsId: string,
  rootPath: string,
  nameSource: string,
  baseRef?: string,
): Promise<{ worktreeId: string; branch: string; cwd: string } | null> {
  if (!(await isGitRepo(rootPath))) return null
  const suffix = generateId().replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || 'wt'
  const branch = `cate-agent/${toBranchName(nameSource)}-${suffix}`
  const targetPath = worktreePathFor(rootPath, branch)
  try {
    await window.electronAPI.gitWorktreeAdd(rootPath, branch, targetPath, { createBranch: true, baseRef })
  } catch (err) {
    log.warn('[cateAgentTools] worktree add failed for %s: %O', branch, err)
    return null
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
  gitStatusStore.refresh(rootPath)
  return { worktreeId: meta.id, branch, cwd: targetPath }
}

/** Surface a short FYI from the Cate Agent into the persistent feedback log. */
function setRemark(wsId: string, text: string): void {
  useCateAgentStore.getState().appendFeed(wsId, 'agent', text)
}

/** Flag unseen activity for the toolbar attention dot when the panel is closed. */
function flagUnseen(wsId: string): void {
  if (!useCateAgentStore.getState().get(wsId).inputOpen) useCateAgentStore.getState().setUnseen(wsId, true)
}

// --- observe context --------------------------------------------------------

/** Snapshot of the workspace the observer needs every turn. */
export async function buildObserveContext(wsId: string, rootPath: string): Promise<string> {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
  const panels = ws ? Object.values(ws.panels) : []
  const openPanels = panels.map((p) => ({ type: p.type, title: p.title }))
  const terminals = panels
    .filter((p) => p.type === 'terminal')
    .map((p) => {
      const ptyId = ptyFor(p.id)
      return { terminalId: shortId(p.id), title: p.title, busy: ptyId ? terminalBusy(wsId, p.id) : false }
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

// --- iteration state --------------------------------------------------------

function iterationById(rootPath: string, iterationId: string): { todo: Todo; iteration: Iteration } | undefined {
  for (const t of useTodosStore.getState().getTodos(rootPath)) {
    const it = t.iterations?.find((i) => i.id === iterationId)
    if (it) return { todo: t, iteration: it }
  }
  return undefined
}

/** Patch one iteration on its todo, persisting the whole iterations array. */
export function patchIteration(rootPath: string, todoId: string, iterationId: string, patch: Partial<Iteration>): void {
  const todo = todoById(rootPath, todoId)
  if (!todo) return
  const iterations = (todo.iterations ?? []).map((i) => (i.id === iterationId ? { ...i, ...patch } : i))
  useTodosStore.getState().patchTodo(rootPath, todoId, { iterations })
}

function iterationTerminalIds(iteration: Iteration): string[] {
  return iteration.agents.map((a) => a.terminalId).filter(Boolean)
}

/** Safety backstop for the settle wait — longer than any single driver run, since
 *  the per-iteration driver itself self-times-out (codingAgentLauncher). */
const SETTLE_WAIT_TIMEOUT_MS = 35 * 60_000

/** Resolve once none of the given iterations is still `running` — i.e. their work
 *  drivers have settled (each flips its iteration to `finished`/`error` on settle).
 *  Lets the orchestrator yield while several iterations run in parallel. */
export function waitForIterationsSettled(rootPath: string, iterationIds: string[]): Promise<void> {
  const stillRunning = (): boolean => iterationIds.some((id) => iterationById(rootPath, id)?.iteration.status === 'running')
  return new Promise((resolve) => {
    if (!stillRunning()) {
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
    const unsub = useTodosStore.subscribe(() => {
      if (!stillRunning()) finish()
    })
    const timer = setTimeout(finish, SETTLE_WAIT_TIMEOUT_MS)
  })
}

/** Compact snapshot of a todo's loop state — goal, check, and every iteration's
 *  status/verdict/terminals/worktree path — injected into the orchestrator's wake
 *  prompt so it sees what finished without rediscovering it. The worktree path lets
 *  the orchestrator inspect an iteration's diff (`git -C <worktreePath> diff`). */
export function buildOrchestratorContext(wsId: string, rootPath: string, todoId: string): string {
  const todo = todoById(rootPath, todoId)
  if (!todo) return json({ error: 'todo gone' })
  const iterations = (todo.iterations ?? []).map((it) => ({
    iterationId: shortId(it.id),
    round: it.round,
    status: it.status,
    worktreePath: it.worktreeId ? worktreeMetaFor(wsId, it.worktreeId)?.path ?? null : null,
    // Only the WORK agents — verification is controller-managed and surfaced via
    // `verdict`, so the verifier's terminals would just be noise here.
    agents: it.agents
      .filter((a) => a.kind !== 'verify')
      .map((a) => ({ agent: a.agent, scope: a.scope, terminalId: shortId(a.terminalId), busy: terminalBusy(wsId, a.terminalId) })),
    verdict: it.verify ? { met: it.verify.met, reason: it.verify.reason } : null,
  }))
  return json({
    goal: todo.goal ?? null,
    check: todo.check ?? null,
    round: todo.round ?? 0,
    iterations,
  })
}

// --- iteration check (Option B — an independent VERIFIER driver) -------------

/** Run the goal check for one finished iteration through a single-agent VERIFIER
 *  driver (the same driver mechanism as the work, but independent of it). The
 *  verifier driver launches a coding-agent CLI in the iteration's worktree, submits
 *  the verify prompt (background:true), and is woken on completion; the coding agent
 *  writes {met, reason} to `.cate/verdict.json`. Once the driver settles we read that
 *  verdict back. Strict: any missing/garbled verdict counts as NOT met. The verifier
 *  driver's throwaway terminal is closed on settle (by runDriverToCompletion). */
export async function runIterationCheck(
  wsId: string,
  rootPath: string,
  todo: Todo,
  iteration: Iteration,
): Promise<{ met: boolean; reason: string }> {
  const meta = iteration.worktreeId ? worktreeMetaFor(wsId, iteration.worktreeId) : undefined
  const cwd = meta?.path ?? rootPath
  const goal = todo.goal ?? todo.title
  const check = todo.check?.trim() || `Confirm this is done: ${goal}`
  const glow = meta?.color ?? 'rgb(var(--agent-rgb))'
  const prompt = [
    `Verify this goal in this worktree: "${goal}". How: ${check}.`,
    'Run the needed tests/build and inspect git diff. Be strict: if you cannot confirm it, it is NOT met.',
    'Write the verdict to .cate/verdict.json as {"met": <true|false>, "reason": "<one sentence>"}, then stop. Change nothing else.',
  ].join(' ')

  await runDriverToCompletion({
    wsId,
    rootPath,
    cwd,
    glow,
    worktreeId: iteration.worktreeId,
    todoId: todo.id,
    iterationId: iteration.id,
    driverKind: 'verify',
    overview: prompt,
  })
  return readVerdict(cwd)
}

/** Read + parse `.cate/verdict.json` from a worktree. Anything unreadable or
 *  malformed is a NOT-met verdict (the checker failed to commit to a clear pass). */
async function readVerdict(cwd: string): Promise<{ met: boolean; reason: string }> {
  try {
    const raw = await window.electronAPI.fsReadFile(`${cwd}/.cate/verdict.json`)
    const parsed = JSON.parse(raw) as { met?: unknown; reason?: unknown }
    const met = parsed.met === true
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : met ? 'met' : 'not met'
    return { met, reason }
  } catch {
    return { met: false, reason: 'the checker did not produce a clear verdict' }
  }
}

// --- tool dispatch ----------------------------------------------------------

export async function runCateAgentTool(ctx: CateAgentContext, tool: string, params: Record<string, unknown>): Promise<string> {
  const { rootPath, workspaceId: wsId } = ctx
  const todos = useTodosStore.getState()

  switch (tool) {
    // --- shared ---
    case 'read_terminal': {
      const terminalId = resolveTerminalId(wsId, String(params.terminalId ?? ''))
      return json(await readTerminalState(wsId, terminalId))
    }

    // --- driver ---
    case 'create_terminal': {
      // Bare shell only — the driver starts the CLI with its first send_keys, so any
      // command param is ignored. Driver-only (it needs the iteration's worktree cwd).
      if (ctx.role !== 'driver') return json({ ok: false, error: 'create_terminal is a driver-only tool' })
      const terminalId = await openDriverTerminal(ctx)
      // Optional driver-chosen title — names the terminal for its tab + job-card chip.
      // renamePanelByUser marks it overridden so the detected CLI name ("Claude Code")
      // doesn't clobber it.
      const title = typeof params.title === 'string' ? params.title.trim() : ''
      if (title) useAppStore.getState().renamePanelByUser(wsId, terminalId, title.slice(0, 60))
      // Track the terminal on the todo so stop() can Ctrl-C it.
      if (ctx.todoId) {
        const cur = todoById(rootPath, ctx.todoId)
        todos.patchTodo(rootPath, ctx.todoId, { terminalNodeIds: [...(cur?.terminalNodeIds ?? []), terminalId] })
      }
      // Record on the iteration (work AND verify drivers) so every terminal gets a
      // job-card chip and is closed with the iteration by select_winner / round-
      // discard. `kind` keeps the verifier's terminals distinct so the orchestrator
      // context and winner note stay scoped to the WORK agents.
      if (ctx.iterationId && (ctx.driverKind === 'work' || ctx.driverKind === 'verify')) {
        const found = iterationById(rootPath, ctx.iterationId)
        if (found) {
          const kind = ctx.driverKind === 'verify' ? 'verify' : 'work'
          patchIteration(rootPath, found.todo.id, ctx.iterationId, {
            agents: [...found.iteration.agents, { agent: kind === 'verify' ? 'verifier' : 'coding agent', kind, terminalId }],
          })
        }
      }
      return json({ terminalId: shortId(terminalId) })
    }

    case 'send_keys': {
      const terminalId = resolveTerminalId(wsId, String(params.terminalId ?? ''))
      const ptyId = ptyFor(terminalId)
      if (!ptyId) return json({ ok: false, error: `no live terminal ${terminalId}` })
      const keys = String(params.keys ?? '')
      const enter = params.enter !== false // default true: append a submit (Enter)
      try {
        // The submit Enter MUST be a separate write, after a beat. A TUI like Claude
        // Code uses bracketed-paste/burst detection: a `\r` arriving in the same chunk
        // as a text blob is treated as a pasted newline (composed into the input), not
        // a submit — so the task gets typed but never sent. Writing the text, pausing,
        // then writing a lone `\r` makes the Enter a discrete keypress that submits.
        if (keys) await window.electronAPI.terminalWrite(ptyId, keys)
        if (enter) {
          if (keys) await new Promise((r) => setTimeout(r, SUBMIT_ENTER_DELAY_MS))
          await window.electronAPI.terminalWrite(ptyId, '\r')
        }
      } catch (err) {
        return json({ ok: false, error: String(err) })
      }
      // background:true arms a one-shot wake — when this terminal's coding-agent turn
      // finishes (running -> finished), the owning driver is re-prompted. The driver
      // submits the task this way and then ends its turn.
      if (params.background === true) armBackgroundSend(wsId, terminalId)
      return json({ ok: true })
    }

    case 'remark': {
      const text = String(params.text ?? '').trim()
      if (!text) return json({ ok: false, error: 'text is required' })
      setRemark(wsId, text.slice(0, 200))
      return json({ ok: true })
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
      if (!useCateAgentStore.getState().get(wsId).inputOpen) useCateAgentStore.getState().setUnseen(wsId, true)
      return json({ ok: true, id: todo.id })
    }

    // --- orchestrator ---
    case 'set_goal': {
      const todoId = String(ctx.todoId ?? '')
      const goal = String(params.goal ?? '').trim()
      const check = String(params.check ?? '').trim() || `Confirm this is done: ${goal}`
      const todo = todoById(rootPath, todoId)
      if (!todo) return json({ ok: false, error: `no todo ${todoId}` })
      if (!goal) return json({ ok: false, error: 'goal is required' })
      todos.patchTodo(rootPath, todoId, {
        goal,
        check,
        round: 0,
        iterations: todo.iterations ?? [],
      })
      return json({
        ok: true,
        note: 'Goal recorded. iterate to spawn attempts; each is verified automatically.',
      })
    }

    case 'iterate': {
      const todoId = String(ctx.todoId ?? '')
      const overview = String(params.overview ?? '').trim()
      const todo = todoById(rootPath, todoId)
      if (!todo) return json({ ok: false, error: `no todo ${todoId}` })
      if (!todo.goal) return json({ ok: false, error: 'set_goal first.' })
      if (!overview) return json({ ok: false, error: 'overview is required' })

      // Round inference: a new round begins when every iteration in the current
      // round has settled to a non-winning verdict (failed/error/cancelled). Then
      // the previous round's worktrees are discarded (fresh every round). Otherwise
      // this is another parallel attempt in the SAME round.
      const curRound = todo.round ?? 0
      const curIters = (todo.iterations ?? []).filter((i) => i.round === curRound)
      const roundDone = curRound === 0 || (curIters.length > 0 && curIters.every((i) => i.status === 'failed' || i.status === 'error' || i.status === 'cancelled'))
      let round = curRound
      if (roundDone) {
        round = curRound + 1
        // Discard the previous round's worktrees (and their terminals).
        for (const old of curIters) {
          for (const tid of iterationTerminalIds(old)) closeCanvasPanel(wsId, tid)
          await teardownWorktree(wsId, rootPath, old.worktreeId)
        }
        const kept = (todo.iterations ?? []).map((i) => (i.round === curRound ? { ...i, status: 'cancelled' as const } : i))
        todos.patchTodo(rootPath, todoId, { iterations: kept, round })
      }

      // Fresh worktree for this iteration, branched off HEAD.
      const indexInRound = (todoById(rootPath, todoId)?.iterations ?? []).filter((i) => i.round === round).length + 1
      const nameSource = `${todo.topic || todo.title} r${round}-${indexInRound}`
      const wt = await createWorktree(wsId, rootPath, nameSource)
      const cwd = wt?.cwd ?? rootPath
      const glow = wt ? worktreeMetaFor(wsId, wt.worktreeId)?.color ?? 'rgb(var(--agent-rgb))' : 'rgb(var(--agent-rgb))'

      // Record the iteration with NO pre-seeded agents — the driver discovers them
      // as it creates terminals.
      const iterationId = `it-${generateId()}`
      const iteration: Iteration = {
        id: iterationId,
        todoId,
        round,
        worktreeId: wt?.worktreeId,
        branch: wt?.branch,
        agents: [],
        status: 'running',
        createdAt: Date.now(),
      }
      const cur = todoById(rootPath, todoId)
      todos.patchTodo(rootPath, todoId, { iterations: [...(cur?.iterations ?? []), iteration] })

      // Spawn ONE per-iteration driver, seeded with the overview + worktree cwd. It
      // runs in the background; on settle (no outstanding background send_keys) we
      // flip the iteration to `finished`, which the controller observes to run the
      // check. The driver's messages never reach the orchestrator.
      const markSettled = (status: 'finished' | 'error'): void => {
        const found = iterationById(rootPath, iterationId)
        if (found && found.iteration.status === 'running') patchIteration(rootPath, todoId, iterationId, { status })
      }
      void runDriverToCompletion({ wsId, rootPath, cwd, glow, worktreeId: wt?.worktreeId, todoId, iterationId, driverKind: 'work', overview })
        .then((ok) => markSettled(ok ? 'finished' : 'error'))
        .catch((err) => {
          log.warn('[cateAgentTools] iteration %s driver failed: %O', iterationId, err)
          markSettled('error')
        })
      return json({ ok: true, iterationId: shortId(iterationId), round })
    }

    case 'select_winner': {
      const todoId = String(ctx.todoId ?? '')
      const iterationId = resolveIterationId(rootPath, todoId, String(params.iterationId ?? ''))
      const reason = String(params.reason ?? '').trim()
      const todo = todoById(rootPath, todoId)
      const winner = todo?.iterations?.find((i) => i.id === iterationId)
      if (!todo || !winner) return json({ ok: false, error: 'todo or iteration not found' })
      if (!winner.worktreeId || !winner.branch) {
        return json({ ok: false, error: 'winning iteration has no worktree to land (non-git?) — use update_todo instead.' })
      }
      // Discard every OTHER iteration's worktree; the winner's branch is what the
      // user lands.
      for (const it of todo.iterations ?? []) {
        if (it.id === iterationId) continue
        for (const tid of iterationTerminalIds(it)) closeCanvasPanel(wsId, tid)
        await teardownWorktree(wsId, rootPath, it.worktreeId)
      }
      const iterations = (todo.iterations ?? []).map((i) =>
        i.id === iterationId ? { ...i, status: 'passed' as const } : { ...i, status: 'cancelled' as const },
      )
      todos.patchTodo(rootPath, todoId, {
        iterations,
        recommendedIterationId: iterationId,
        worktreeId: winner.worktreeId,
        branch: winner.branch,
        status: 'review',
        note: reason || `Winner: ${winner.agents.filter((a) => a.kind !== 'verify').map((a) => a.agent).join(' + ')}`,
      })
      flagUnseen(wsId)
      return json({ ok: true })
    }

    case 'answer': {
      const text = String(params.text ?? '').trim()
      const todoId = String(ctx.todoId ?? '')
      if (!todoId || !text) return json({ ok: false, error: 'todoId and text are required' })
      todos.patchTodo(rootPath, todoId, { output: text, status: 'done' })
      flagUnseen(wsId)
      return json({ ok: true })
    }

    case 'update_todo': {
      const todoId = String(ctx.todoId ?? '')
      const patch: Partial<Todo> = {}
      const topic = typeof params.topic === 'string' ? params.topic.trim() : ''
      if (topic) patch.topic = topic.slice(0, 60)
      if (params.status === 'failed' || params.status === 'in_progress') patch.status = params.status as TodoStatus
      if (typeof params.note === 'string') patch.note = params.note
      if (Object.keys(patch).length === 0) return json({ ok: false, error: 'nothing to update' })
      todos.patchTodo(rootPath, todoId, patch)
      if (patch.status === 'failed') flagUnseen(wsId)
      return json({ ok: true })
    }

    default:
      return json({ ok: false, error: `unknown tool ${tool}` })
  }
}
