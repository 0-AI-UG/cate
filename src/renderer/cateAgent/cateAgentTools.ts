// =============================================================================
// cateAgentTools — the fulfilment side of the cate-agent-tools extension. Each
// Cate Agent tool call arrives here (via cateAgentBridge) as {tool, params} with
// the calling session's CateAgentContext, and is carried out against the live
// renderer stores + IPC APIs.
//
// The chat agent's job model is loop-based:
//   - The CHAT AGENT (orchestrator role, read-only — no write/edit tools) answers a
//     question inline, or for a code change sets a goal + how to check it, then spawns
//     parallel ITERATIONS. Each iterate creates a fresh worktree and spawns ONE
//     per-iteration DRIVER (via codingAgentLauncher) seeded with the overview; that
//     driver decides the agent decomposition, launches the coding-agent CLIs, and
//     drives them to completion. The chat agent never chooses agents or edits files.
//   - Each iteration is CHECKED through a single-agent VERIFIER driver
//     (runIterationCheck): it runs the check in the worktree and writes a verdict to
//     `.cate/verdict.json`, which the controller reads back.
//
// Tool handlers mutate the chat's run/messages + drive terminals; all session
// lifecycle (running the checks, waking the agent) lives in the controller, which
// observes this state on each yield. Every handler returns a model-readable string
// (JSON or prose) surfaced verbatim as the tool result. Each agent action appends or
// patches a typed transcript block (plan / attempts / result / canvas).
//
// Terminal primitives live in cateAgentTerminals; the "run a driver to completion"
// primitive lives in codingAgentLauncher — both shared with this module.
// =============================================================================

import { useAppStore, pickWorktreeColor } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useChatsStore } from '../stores/chatsStore'
import { gitStatusStore } from '../stores/gitStatusStore'
import { useCateAgentStore } from './cateAgentStore'
import { generateId } from '../stores/canvas/helpers'
import type { Chat, ChatRun, WorktreeMeta, Iteration } from '../../shared/types'
import type { CateAgentContext } from './cateAgentTypes'
import {
  ptyFor,
  closeCanvasPanel,
  terminalBusy,
  readTerminalState,
  shortId,
} from './cateAgentTerminals'
import { runDriverToCompletion, openDriverTerminal, armBackgroundSend } from './codingAgentLauncher'
import { runCanvasAgentToCompletion } from './canvasAgentLauncher'
import { teardownRunWork } from './cateAgentReviewActions'
import { worktreeMetaFor, teardownWorktree } from './cateAgentWorktrees'
import { getAgentCanvasStore } from '../lib/workspace/canvasAccess'
import type { PanelType, Point } from '../../shared/types'
import log from '../lib/logger'

const json = (v: unknown): string => JSON.stringify(v)

/** Pause between writing send_keys text and the lone submit `\r`, so a TUI's
 *  bracketed-paste/burst detection sees the Enter as a discrete keypress (a submit)
 *  rather than a pasted newline. */
const SUBMIT_ENTER_DELAY_MS = 150

// --- store shorthands --------------------------------------------------------

function getChat(rootPath: string, chatId: string): Chat | undefined {
  return useChatsStore.getState().getChat(rootPath, chatId)
}

function runFor(rootPath: string, chatId: string): ChatRun | undefined {
  return useChatsStore.getState().getRun(rootPath, chatId)
}

function patchRun(rootPath: string, chatId: string, patch: Partial<ChatRun>): void {
  useChatsStore.getState().patchRun(rootPath, chatId, patch)
}

function msgId(): string {
  return `msg-${generateId()}`
}

// --- helpers ----------------------------------------------------------------

/** The agent is handed `shortId(...)` prefixes; recover the real id by prefix-
 *  matching the live candidate set. Falls through to the supplied string (so a
 *  bad/empty id still produces the natural "not found" error downstream). */
function resolveTerminalId(wsId: string, supplied: string): string {
  if (!supplied) return supplied
  const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
  const hit = ws && Object.values(ws.panels).find((p) => p.type === 'terminal' && p.id.startsWith(supplied))
  return hit ? hit.id : supplied
}

/** Canvas variant of resolveTerminalId: the canvas subagent is handed `shortId(...)`
 *  panel prefixes for panels of ANY type; recover the real id by prefix-match. */
function resolvePanelId(wsId: string, supplied: string): string {
  if (!supplied) return supplied
  const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
  const hit = ws && Object.values(ws.panels).find((p) => p.id.startsWith(supplied))
  return hit ? hit.id : supplied
}

/** A snapshot of every panel currently on the workspace canvas — id (shortened),
 *  type, title, and canvas-space position/size — with a short screen preview for
 *  terminals so the canvas subagent can lay panels out by their contents. Returns a
 *  JSON string ({panels:[...]}) ready to hand back as a tool result. */
async function buildCanvasSnapshot(wsId: string, canvasPanelId?: string): Promise<string> {
  const store = getAgentCanvasStore(wsId, canvasPanelId)
  if (!store) return json({ panels: [], note: 'no canvas in this workspace' })
  const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
  const nodes = Object.values(store.getState().nodes)
  const panels = await Promise.all(
    nodes.map(async (node) => {
      const panel = ws?.panels[node.panelId]
      const base = {
        id: shortId(node.panelId),
        type: panel?.type ?? 'unknown',
        title: panel?.title ?? '',
        x: Math.round(node.origin.x),
        y: Math.round(node.origin.y),
        w: Math.round(node.size.width),
        h: Math.round(node.size.height),
      }
      if (panel?.type === 'terminal') {
        try {
          const state = await readTerminalState(wsId, node.panelId)
          const preview = state.output.trim().slice(-400)
          return { ...base, preview }
        } catch {
          /* preview is best-effort */
        }
      }
      return base
    }),
  )
  return json({ panels })
}

function resolveIterationId(rootPath: string, chatId: string, supplied: string): string {
  if (!supplied) return supplied
  const hit = runFor(rootPath, chatId)?.iterations?.find((i) => i.id.startsWith(supplied))
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

/** Derive a short chat title from a prompt, deterministically (no model call). Used
 *  to title chats and name worktree branches. */
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

/** Surface a short FYI from the observer into the persistent feedback log. */
function setRemark(wsId: string, text: string): void {
  useCateAgentStore.getState().appendFeed(wsId, 'agent', text)
}

/** Surface an observer suggestion: a feed line carrying a one-click, ready-to-run
 *  prompt for the coding agent (button labelled by the observer). */
function setSuggestion(wsId: string, text: string, label: string, prompt: string): void {
  useCateAgentStore.getState().appendFeed(wsId, 'agent', text, { label, prompt })
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
  return json({ branch, changedFiles, openPanels, terminals })
}

// --- iteration state --------------------------------------------------------

function iterationById(rootPath: string, iterationId: string): { chatId: string; iteration: Iteration } | undefined {
  for (const c of useChatsStore.getState().getChats(rootPath)) {
    const it = c.run?.iterations?.find((i) => i.id === iterationId)
    if (it) return { chatId: c.id, iteration: it }
  }
  return undefined
}

/** Patch one iteration on its chat's run, persisting the whole iterations array. */
export function patchIteration(rootPath: string, chatId: string, iterationId: string, patch: Partial<Iteration>): void {
  const run = runFor(rootPath, chatId)
  if (!run) return
  const iterations = (run.iterations ?? []).map((i) => (i.id === iterationId ? { ...i, ...patch } : i))
  patchRun(rootPath, chatId, { iterations })
}

function iterationTerminalIds(iteration: Iteration): string[] {
  return iteration.agents.map((a) => a.terminalId).filter(Boolean)
}

/** Safety backstop for the settle wait — longer than any single driver run, since
 *  the per-iteration driver itself self-times-out (codingAgentLauncher). */
const SETTLE_WAIT_TIMEOUT_MS = 35 * 60_000

/** Resolve once none of the given iterations is still `running` — i.e. their work
 *  drivers have settled (each flips its iteration to `finished`/`error` on settle).
 *  Lets the chat agent yield while several iterations run in parallel. */
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
    const unsub = useChatsStore.subscribe(() => {
      if (!stillRunning()) finish()
    })
    const timer = setTimeout(finish, SETTLE_WAIT_TIMEOUT_MS)
  })
}

/** Compact snapshot of a run's loop state — goal, check, and every iteration's
 *  status/verdict/terminals/worktree path — injected into the chat agent's wake
 *  prompt so it sees what finished without rediscovering it. The worktree path lets
 *  it inspect an iteration's diff (`git -C <worktreePath> diff`). */
export function buildRunContext(wsId: string, rootPath: string, chatId: string): string {
  const run = runFor(rootPath, chatId)
  if (!run) return json({ error: 'run gone' })
  const iterations = (run.iterations ?? []).map((it) => ({
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
    goal: run.goal ?? null,
    check: run.check ?? null,
    round: run.round ?? 0,
    iterations,
  })
}

// --- iteration check (an independent VERIFIER driver) ------------------------

/** Run the goal check for one finished iteration through a single-agent VERIFIER
 *  driver (the same driver mechanism as the work, but independent of it). The
 *  verifier driver launches a coding-agent CLI in the iteration's worktree, submits
 *  the verify prompt (background:true), and is woken on completion; the coding agent
 *  writes {met, reason} to `.cate/verdict.json`. Once the driver settles we read that
 *  verdict back. Strict: any missing/garbled verdict counts as NOT met. */
export async function runIterationCheck(
  wsId: string,
  rootPath: string,
  chatId: string,
  iteration: Iteration,
): Promise<{ met: boolean; reason: string }> {
  const run = runFor(rootPath, chatId)
  const meta = iteration.worktreeId ? worktreeMetaFor(wsId, iteration.worktreeId) : undefined
  const cwd = meta?.path ?? rootPath
  const goal = run?.goal ?? chatTitleFor(rootPath, chatId)
  const check = run?.check?.trim() || `Confirm this is done: ${goal}`
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
    chatId,
    iterationId: iteration.id,
    driverKind: 'verify',
    overview: prompt,
    canvasPanelId: run?.canvasPanelId,
  })
  return readVerdict(cwd)
}

function chatTitleFor(rootPath: string, chatId: string): string {
  return getChat(rootPath, chatId)?.title ?? 'the task'
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
      // Optional driver-chosen title — names the terminal for its tab + block chip.
      const title = typeof params.title === 'string' ? params.title.trim() : ''
      if (title) useAppStore.getState().renamePanelByUser(wsId, terminalId, title.slice(0, 60))
      // Track the terminal on the run so stop() can Ctrl-C it.
      if (ctx.chatId) {
        const cur = runFor(rootPath, ctx.chatId)
        patchRun(rootPath, ctx.chatId, { terminalNodeIds: [...(cur?.terminalNodeIds ?? []), terminalId] })
      }
      // Record on the iteration (work AND verify drivers) so every terminal gets a
      // block chip and is closed with the iteration by select_winner / round-discard.
      if (ctx.iterationId && (ctx.driverKind === 'work' || ctx.driverKind === 'verify')) {
        const found = iterationById(rootPath, ctx.iterationId)
        if (found) {
          const kind = ctx.driverKind === 'verify' ? 'verify' : 'work'
          patchIteration(rootPath, found.chatId, ctx.iterationId, {
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
        // as a text blob is treated as a pasted newline, not a submit. Writing the
        // text, pausing, then a lone `\r` makes the Enter a discrete keypress.
        if (keys) await window.electronAPI.terminalWrite(ptyId, keys)
        if (enter) {
          if (keys) await new Promise((r) => setTimeout(r, SUBMIT_ENTER_DELAY_MS))
          await window.electronAPI.terminalWrite(ptyId, '\r')
        }
      } catch (err) {
        return json({ ok: false, error: String(err) })
      }
      // background:true arms a one-shot wake — when this terminal's coding-agent turn
      // finishes, the owning driver is re-prompted.
      if (params.background === true) armBackgroundSend(wsId, terminalId)
      return json({ ok: true })
    }

    case 'remark': {
      const text = String(params.text ?? '').trim()
      if (!text) return json({ ok: false, error: 'text is required' })
      setRemark(wsId, text.slice(0, 200))
      return json({ ok: true })
    }

    case 'suggest': {
      const text = String(params.text ?? '').trim()
      const label = String(params.label ?? '').trim()
      const prompt = String(params.prompt ?? '').trim()
      if (!text || !prompt) return json({ ok: false, error: 'text and prompt are required' })
      setSuggestion(wsId, text.slice(0, 200), (label || 'Run').slice(0, 24), prompt.slice(0, 4000))
      return json({ ok: true })
    }

    // --- chat agent: define → iterate → select ---
    case 'set_goal': {
      const chatId = String(ctx.chatId ?? '')
      const goal = String(params.goal ?? '').trim()
      const check = String(params.check ?? '').trim() || `Confirm this is done: ${goal}`
      if (!getChat(rootPath, chatId)) return json({ ok: false, error: `no chat ${chatId}` })
      if (!goal) return json({ ok: false, error: 'goal is required' })
      // A fresh code task supersedes any prior run in this chat — tear down its
      // worktrees/terminals first so a lingering unlanded review doesn't leak, then
      // reset the run loop layer (a new attempts grid is minted on the first iterate).
      const prior = runFor(rootPath, chatId)
      if (prior) await teardownRunWork(wsId, rootPath, prior, { deleteBranch: true })
      patchRun(rootPath, chatId, {
        status: 'running',
        goal,
        check,
        round: 0,
        iterations: [],
        recommendedIterationId: undefined,
        worktreeId: undefined,
        branch: undefined,
        terminalNodeIds: undefined,
        attemptsMessageId: undefined,
        note: undefined,
      })
      useChatsStore.getState().appendMessage(rootPath, chatId, { id: msgId(), role: 'agent', ts: Date.now(), kind: 'plan', goal, check })
      return json({ ok: true, note: 'Goal recorded. iterate to spawn attempts; each is verified automatically.' })
    }

    case 'iterate': {
      const chatId = String(ctx.chatId ?? '')
      const overview = String(params.overview ?? '').trim()
      let run = runFor(rootPath, chatId)
      const chat = getChat(rootPath, chatId)
      if (!chat) return json({ ok: false, error: `no chat ${chatId}` })
      if (!run?.goal) return json({ ok: false, error: 'set_goal first.' })
      if (!overview) return json({ ok: false, error: 'overview is required' })

      // Mint the live attempts grid block on the first iterate of this task.
      if (!run.attemptsMessageId) {
        const mid = msgId()
        useChatsStore.getState().appendMessage(rootPath, chatId, { id: mid, role: 'agent', ts: Date.now(), kind: 'attempts' })
        patchRun(rootPath, chatId, { attemptsMessageId: mid })
        run = runFor(rootPath, chatId)!
      }

      // Round inference: a new round begins when every iteration in the current round
      // has settled to a non-winning verdict. Then the previous round's worktrees are
      // discarded. Otherwise this is another parallel attempt in the SAME round.
      const curRound = run.round ?? 0
      const curIters = (run.iterations ?? []).filter((i) => i.round === curRound)
      const roundDone = curRound === 0 || (curIters.length > 0 && curIters.every((i) => i.status === 'failed' || i.status === 'error' || i.status === 'cancelled'))
      // Cap on simultaneous attempts (Settings → Cate Agent). Only applies when adding
      // to a live round; a new round always starts from zero.
      if (!roundDone) {
        const cap = Math.max(1, Math.round(Number(useSettingsStore.getState().cateAgentMaxParallelIterations) || 3))
        const active = curIters.filter((i) => i.status === 'running' || i.status === 'finished' || i.status === 'verifying').length
        if (active >= cap) {
          return json({
            ok: false,
            error: `round ${curRound} already has ${active} active attempts (the user caps parallel attempts at ${cap}). Wait for their verdicts instead of iterating again.`,
          })
        }
      }
      let round = curRound
      if (roundDone) {
        round = curRound + 1
        // Discard the previous round's worktrees (and their terminals).
        for (const old of curIters) {
          for (const tid of iterationTerminalIds(old)) closeCanvasPanel(wsId, tid)
          await teardownWorktree(wsId, rootPath, old.worktreeId)
        }
        const kept = (run.iterations ?? []).map((i) => (i.round === curRound ? { ...i, status: 'cancelled' as const } : i))
        patchRun(rootPath, chatId, { iterations: kept, round })
      }

      // Fresh worktree for this iteration, branched off HEAD.
      const indexInRound = (runFor(rootPath, chatId)?.iterations ?? []).filter((i) => i.round === round).length + 1
      const nameSource = `${chat.title} r${round}-${indexInRound}`
      const wt = await createWorktree(wsId, rootPath, nameSource)
      const cwd = wt?.cwd ?? rootPath
      const glow = wt ? worktreeMetaFor(wsId, wt.worktreeId)?.color ?? 'rgb(var(--agent-rgb))' : 'rgb(var(--agent-rgb))'

      // Record the iteration with NO pre-seeded agents — the driver discovers them.
      const iterationId = `it-${generateId()}`
      const iteration: Iteration = {
        id: iterationId,
        todoId: chatId,
        round,
        worktreeId: wt?.worktreeId,
        branch: wt?.branch,
        agents: [],
        status: 'running',
        createdAt: Date.now(),
      }
      const cur = runFor(rootPath, chatId)
      patchRun(rootPath, chatId, { iterations: [...(cur?.iterations ?? []), iteration] })

      // Spawn ONE per-iteration driver, seeded with the overview + worktree cwd. On
      // settle we flip the iteration to `finished`, which the controller observes to
      // run the check. The driver's messages never reach the chat agent.
      const markSettled = (status: 'finished' | 'error'): void => {
        const found = iterationById(rootPath, iterationId)
        if (found && found.iteration.status === 'running') patchIteration(rootPath, chatId, iterationId, { status })
      }
      void runDriverToCompletion({ wsId, rootPath, cwd, glow, worktreeId: wt?.worktreeId, chatId, iterationId, driverKind: 'work', overview, canvasPanelId: ctx.canvasPanelId })
        .then((ok) => markSettled(ok ? 'finished' : 'error'))
        .catch((err) => {
          log.warn('[cateAgentTools] iteration %s driver failed: %O', iterationId, err)
          markSettled('error')
        })
      return json({ ok: true, iterationId: shortId(iterationId), round })
    }

    case 'select_winner': {
      const chatId = String(ctx.chatId ?? '')
      const iterationId = resolveIterationId(rootPath, chatId, String(params.iterationId ?? ''))
      const reason = String(params.reason ?? '').trim()
      const run = runFor(rootPath, chatId)
      const winner = run?.iterations?.find((i) => i.id === iterationId)
      if (!run || !winner) return json({ ok: false, error: 'run or iteration not found' })
      if (!winner.worktreeId || !winner.branch) {
        return json({ ok: false, error: 'winning iteration has no worktree to land (non-git?) — use fail instead.' })
      }
      // Discard every OTHER iteration's worktree; the winner's branch is what lands.
      for (const it of run.iterations ?? []) {
        if (it.id === iterationId) continue
        for (const tid of iterationTerminalIds(it)) closeCanvasPanel(wsId, tid)
        await teardownWorktree(wsId, rootPath, it.worktreeId)
      }
      const iterations = (run.iterations ?? []).map((i) =>
        i.id === iterationId ? { ...i, status: 'passed' as const } : { ...i, status: 'cancelled' as const },
      )
      const note = reason || `Winner: ${winner.agents.filter((a) => a.kind !== 'verify').map((a) => a.agent).join(' + ')}`
      patchRun(rootPath, chatId, {
        iterations,
        recommendedIterationId: iterationId,
        worktreeId: winner.worktreeId,
        branch: winner.branch,
        status: 'review',
        note,
      })
      useChatsStore.getState().appendMessage(rootPath, chatId, {
        id: msgId(),
        role: 'agent',
        ts: Date.now(),
        kind: 'result',
        iterationId,
        met: winner.verify?.met ?? true,
        reason: winner.verify?.reason || note,
        worktreeId: winner.worktreeId,
        branch: winner.branch,
        note,
      })
      return json({ ok: true })
    }

    case 'fail': {
      const chatId = String(ctx.chatId ?? '')
      const reason = String(params.reason ?? '').trim() || 'Could not complete the task.'
      if (!getChat(rootPath, chatId)) return json({ ok: false, error: `no chat ${chatId}` })
      patchRun(rootPath, chatId, { status: 'failed', note: reason })
      useChatsStore.getState().appendMessage(rootPath, chatId, { id: msgId(), role: 'agent', ts: Date.now(), kind: 'result', met: false, reason })
      return json({ ok: true })
    }

    // --- chat agent: delegate a canvas layout task to the canvas subagent ---
    case 'canvas': {
      const chatId = String(ctx.chatId ?? '')
      const request = String(params.request ?? '').trim()
      if (!request) return json({ ok: false, error: 'request is required' })
      const mid = msgId()
      if (chatId) {
        useChatsStore.getState().appendMessage(rootPath, chatId, { id: mid, role: 'agent', ts: Date.now(), kind: 'canvas', request, working: true, canvasPanelId: ctx.canvasPanelId })
      }
      const ok = await runCanvasAgentToCompletion({ wsId, rootPath, request, canvasPanelId: ctx.canvasPanelId })
      const snapshot = JSON.parse(await buildCanvasSnapshot(wsId, ctx.canvasPanelId)) as { panels: Array<{ id: string; type: string; title: string }> }
      if (chatId) {
        useChatsStore.getState().patchMessage(rootPath, chatId, mid, {
          working: false,
          panels: (snapshot.panels ?? []).map((p) => ({ id: p.id, type: p.type, title: p.title })),
        })
      }
      if (!ok) return json({ ok: false, error: 'canvas subagent failed to start' })
      return json({ ok: true, canvas: snapshot })
    }

    // --- canvas subagent ---
    case 'list_canvas':
      return buildCanvasSnapshot(wsId, ctx.canvasPanelId)

    case 'create_panel': {
      const type = String(params.type ?? '') as PanelType
      const pos: Point | undefined =
        typeof params.x === 'number' && typeof params.y === 'number' ? { x: params.x, y: params.y } : undefined
      const placement = { target: 'canvas' as const, focus: false, canvasPanelId: ctx.canvasPanelId }
      const app = useAppStore.getState()
      let panelId: string
      switch (type) {
        case 'terminal':
          panelId = app.createTerminal(wsId, undefined, pos, placement, typeof params.cwd === 'string' ? params.cwd : rootPath)
          break
        case 'browser':
          panelId = app.createBrowser(wsId, typeof params.url === 'string' ? params.url : undefined, pos, placement)
          break
        case 'editor':
          panelId = app.createEditor(wsId, typeof params.filePath === 'string' ? params.filePath : undefined, pos, placement)
          break
        case 'document':
          panelId = app.createDocument(wsId, typeof params.filePath === 'string' ? params.filePath : undefined, undefined, pos, placement)
          break
        case 'canvas':
          panelId = app.createCanvas(wsId, pos, placement)
          break
        case 'agent':
          panelId = app.createAgent(wsId, pos, placement)
          break
        default:
          return json({ ok: false, error: `unknown panel type ${type}` })
      }
      return json({ ok: true, id: shortId(panelId) })
    }

    case 'close_panel': {
      const panelId = resolvePanelId(wsId, String(params.id ?? ''))
      if (!panelId) return json({ ok: false, error: 'id is required' })
      closeCanvasPanel(wsId, panelId)
      return json({ ok: true })
    }

    case 'move_panel': {
      const panelId = resolvePanelId(wsId, String(params.id ?? ''))
      const store = getAgentCanvasStore(wsId, ctx.canvasPanelId)
      if (!store) return json({ ok: false, error: 'no canvas in this workspace' })
      const nodeId = store.getState().nodeForPanel(panelId)
      if (!nodeId) return json({ ok: false, error: `no panel ${String(params.id ?? '')}` })
      store.getState().moveNode(nodeId, { x: Number(params.x) || 0, y: Number(params.y) || 0 })
      return json({ ok: true })
    }

    case 'resize_panel': {
      const panelId = resolvePanelId(wsId, String(params.id ?? ''))
      const store = getAgentCanvasStore(wsId, ctx.canvasPanelId)
      if (!store) return json({ ok: false, error: 'no canvas in this workspace' })
      const nodeId = store.getState().nodeForPanel(panelId)
      if (!nodeId) return json({ ok: false, error: `no panel ${String(params.id ?? '')}` })
      store.getState().resizeNode(nodeId, { width: Number(params.w) || 0, height: Number(params.h) || 0 })
      return json({ ok: true })
    }

    default:
      return json({ ok: false, error: `unknown tool ${tool}` })
  }
}
