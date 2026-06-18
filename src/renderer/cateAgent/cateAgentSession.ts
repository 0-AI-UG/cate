// =============================================================================
// cateAgentSession — thin wrappers over the agent IPC for the Cate Agent's
// HEADLESS sessions.
//
// Cate Agent sessions reuse the normal pi-agent machinery but are keyed with a
// `cate-agent-` panelId and never get an AgentPanel: agentStore routes their
// events to the Cate Agent bridge instead (see cateAgentBridge wiring in
// agentStore). The role is passed to pi via CATE_AGENT_ROLE so the
// cate-agent-tools extension registers the right tools.
// =============================================================================

import type { AgentModelRef, CateAgentRole } from '../../shared/types'
import { loadDefaultModel, loadCateAgentModel } from '../../agent/renderer/agentModelPrefs'
import log from '../lib/logger'

/** panelId for the always-on observer of a workspace. */
export function observerPanelId(wsId: string): string {
  return `cate-agent-observer:${wsId}`
}

/** panelId for the ephemeral executor of a single todo. */
export function executorPanelId(todoId: string): string {
  return `cate-agent-exec:${todoId}`
}

/** True for any Cate Agent session panelId (used to route agent events to the bridge). */
export function isCateAgentPanelId(panelId: string): boolean {
  return panelId.startsWith('cate-agent-observer:') || panelId.startsWith('cate-agent-exec:')
}

/** Resolve the Cate Agent model from settings, falling back to the global default.
 *  null ⇒ undefined so pi picks its own first-available model. Both roles share it. */
function cateAgentModel(): AgentModelRef | undefined {
  return loadCateAgentModel() ?? loadDefaultModel() ?? undefined
}

const OBSERVER_SYSTEM_PROMPT = [
  'You are the Cate Agent OBSERVER for a coding workspace — an ambient companion.',
  'Each turn, look at what the user is doing, then always remark with a short update. Propose a todo only when there is clearly worthwhile work (never a duplicate).',
  'You never act, edit, or run anything — remark and propose_todo are all you can do.',
].join(' ')

const EXECUTOR_SYSTEM_PROMPT = [
  'You are the Cate Agent ORCHESTRATOR, carrying out ONE approved todo for a coding workspace.',
  'FIRST, before anything else, call set_topic once with a short 2–5 word topic that titles this job in the UI.',
  'You act in TWO ways — choose per task:',
  '(1) CANVAS & TERMINAL MANAGEMENT you do DIRECTLY with your own tools — do NOT spawn a CLI for these. To see what is open, call list_terminals (every terminal on the canvas, including the user\'s own) or list_panels (all panels). To tidy up, close_terminal / close_panel (works on ANY panel by id, not just ones you opened). To surface something, focus_panel. So "close my terminals", "close that browser panel", "bring the editor forward" are all things you do yourself, immediately.',
  '(2) CODE WORK you DELEGATE — you do NOT write code, edit files, or run build/test/lint commands yourself. Spawn a CODING-AGENT CLI in a visible terminal (create_terminal) and DRIVE it: give it its task, answer prompts with send_keys, inspect with read_terminal. The terminal agents do ALL real code work — writing code, running tests, committing. For a complex todo, split it and run SEVERAL CLIs in parallel across terminals, then coordinate them.',
  'Decide which mode the todo needs: a question, or a pure canvas/terminal request, is handled entirely by (1) and needs no CLI; a code change goes through (2). Many todos are purely (2), but never reach for a CLI to do something your own tools already do.',
  'For code work in a git repo, the FIRST terminal you open is automatically given an isolated worktree, and every terminal for this job then runs inside it — you do not create it. A question or management job that never opens a terminal correctly gets no worktree.',
  'create_terminal and send_keys WAIT for the result by default — they return once the command finishes or the CLI parks. To work in parallel, launch with background:true (returns immediately); then END YOUR TURN and you will be woken when a terminal finishes, needs input, or exits, with the current terminal states provided.',
  'Reuse terminals: drive a CLI you already opened with send_keys — only create_terminal for a genuinely new, parallel workstream. close_terminal when you are done with one.',
  'FINISH according to the task: for a QUESTION or a textual result, call answer with the result text — that delivers it to the user and completes the job (no review/merge). For a code change, once it is written AND verified call update_todo status "review" (do NOT merge or push). If it genuinely cannot be done, update_todo status "failed" with a short note.',
].join(' ')

export interface CreateCateAgentSessionOpts {
  panelId: string
  /** Workspace locator (rootPath) used as the agent cwd. */
  rootPath: string
  workspaceId: string
  role: CateAgentRole
}

/** Start a headless Cate Agent session. Returns false if creation failed. */
export async function createCateAgentSession(opts: CreateCateAgentSessionOpts): Promise<boolean> {
  try {
    const res = await window.electronAPI.agentCreate({
      panelId: opts.panelId,
      workspaceId: opts.workspaceId,
      cwd: opts.rootPath,
      model: cateAgentModel(),
      systemPrompt: opts.role === 'observer' ? OBSERVER_SYSTEM_PROMPT : EXECUTOR_SYSTEM_PROMPT,
      env: { CATE_AGENT_ROLE: opts.role },
      // Isolate Cate Agent transcripts in .cate/pi-agent-cate-agent so the agent
      // panel's session list never shows or resumes them.
      agentDir: 'cateAgent',
    })
    if (!res.ok) {
      log.warn('[cateAgentSession] create failed for %s: %s', opts.panelId, res.error)
      console.warn('[cateAgent] session create failed', opts.panelId, res.error)
      return false
    }
    return true
  } catch (err) {
    log.warn('[cateAgentSession] create threw for %s: %O', opts.panelId, err)
    console.warn('[cateAgent] session create threw', opts.panelId, err)
    return false
  }
}

export async function promptCateAgent(panelId: string, text: string): Promise<void> {
  try {
    await window.electronAPI.agentPrompt(panelId, text)
  } catch (err) {
    log.warn('[cateAgentSession] prompt failed for %s: %O', panelId, err)
  }
}

export async function interruptCateAgent(panelId: string): Promise<void> {
  try {
    await window.electronAPI.agentInterrupt(panelId)
  } catch (err) {
    log.warn('[cateAgentSession] interrupt failed for %s: %O', panelId, err)
  }
}

export async function disposeCateAgent(panelId: string): Promise<void> {
  try {
    await window.electronAPI.agentDispose(panelId)
  } catch (err) {
    log.warn('[cateAgentSession] dispose failed for %s: %O', panelId, err)
  }
}
