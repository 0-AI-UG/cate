// =============================================================================
// petSession — thin wrappers over the agent IPC for the pet's HEADLESS sessions.
//
// Pet sessions reuse the normal pi-agent machinery but are keyed with a `pet-`
// panelId and never get an AgentPanel: agentStore routes their events to the pet
// bridge instead (see petBridge wiring in agentStore). The role is passed to pi
// via CATE_PET_ROLE so the cate-pet-tools extension registers the right tools.
// =============================================================================

import type { AgentModelRef, PetRole } from '../../shared/types'
import { loadDefaultModel, loadPetModel } from '../../agent/renderer/agentModelPrefs'
import log from '../lib/logger'

/** panelId for the always-on observer of a workspace. */
export function observerPanelId(wsId: string): string {
  return `pet-observer:${wsId}`
}

/** panelId for the ephemeral executor of a single todo. */
export function executorPanelId(todoId: string): string {
  return `pet-exec:${todoId}`
}

/** True for any pet session panelId (used to route agent events to the bridge). */
export function isPetPanelId(panelId: string): boolean {
  return panelId.startsWith('pet-observer:') || panelId.startsWith('pet-exec:')
}

/** Resolve the pet model from settings, falling back to the global default. null
 *  ⇒ undefined so pi picks its own first-available model. Both roles share it. */
function petModel(): AgentModelRef | undefined {
  return loadPetModel() ?? loadDefaultModel() ?? undefined
}

const OBSERVER_SYSTEM_PROMPT = [
  'You are the Canvas Pet OBSERVER for a coding workspace — an ambient companion.',
  'Each turn, look at what the user is doing, then always remark with a short update. Propose a todo only when there is clearly worthwhile work (never a duplicate).',
  'You never act, edit, or run anything — remark and propose_todo are all you can do.',
].join(' ')

const EXECUTOR_SYSTEM_PROMPT = [
  'You are the Canvas Pet ORCHESTRATOR. You carry out ONE approved todo by DELEGATING — never by doing the work yourself.',
  'You do NOT write code, edit files, or run build/test/lint commands directly. You spawn CODING-AGENT CLIs in visible terminals (create_terminal) and DRIVE them: give each its task, answer prompts with send_keys, inspect with read_terminal. The terminal agents do ALL real work — writing code, running tests, committing. For a complex todo, split it and run SEVERAL CLIs in parallel across terminals, then coordinate them.',
  'An isolated worktree is prepared for the todo before you start (git repos only); every terminal you open runs inside it automatically — you do not create it.',
  'create_terminal and send_keys WAIT for the result by default — they return once the command finishes or the CLI parks. To work in parallel, launch with background:true (returns immediately); then END YOUR TURN and you will be woken when a terminal finishes, needs input, or exits, with the current terminal states provided.',
  'Your tools: set_plan, create_terminal, send_keys, read_terminal, close_terminal, update_todo.',
  'Reuse terminals: drive a CLI you already opened with send_keys — only create_terminal for a genuinely new, parallel workstream. close_terminal when you are done with one.',
  'Get oriented, set_plan once you understand the work, then drive the CLIs until the change is written AND verified. Then call update_todo status "review" — do NOT merge or push. If it genuinely cannot be done, update_todo status "failed" with a short note.',
].join(' ')

export interface CreatePetSessionOpts {
  panelId: string
  /** Workspace locator (rootPath) used as the agent cwd. */
  rootPath: string
  workspaceId: string
  role: PetRole
}

/** Start a headless pet session. Returns false if creation failed. */
export async function createPetSession(opts: CreatePetSessionOpts): Promise<boolean> {
  try {
    const res = await window.electronAPI.agentCreate({
      panelId: opts.panelId,
      workspaceId: opts.workspaceId,
      cwd: opts.rootPath,
      model: petModel(),
      systemPrompt: opts.role === 'observer' ? OBSERVER_SYSTEM_PROMPT : EXECUTOR_SYSTEM_PROMPT,
      env: { CATE_PET_ROLE: opts.role },
      // Isolate pet transcripts in .cate/pi-agent-pet so the agent panel's
      // session list never shows or resumes them.
      agentDir: 'pet',
    })
    if (!res.ok) {
      log.warn('[petSession] create failed for %s: %s', opts.panelId, res.error)
      console.warn('[pet] session create failed', opts.panelId, res.error)
      return false
    }
    return true
  } catch (err) {
    log.warn('[petSession] create threw for %s: %O', opts.panelId, err)
    console.warn('[pet] session create threw', opts.panelId, err)
    return false
  }
}

export async function promptPet(panelId: string, text: string): Promise<void> {
  try {
    await window.electronAPI.agentPrompt(panelId, text)
  } catch (err) {
    log.warn('[petSession] prompt failed for %s: %O', panelId, err)
  }
}

export async function interruptPet(panelId: string): Promise<void> {
  try {
    await window.electronAPI.agentInterrupt(panelId)
  } catch (err) {
    log.warn('[petSession] interrupt failed for %s: %O', panelId, err)
  }
}

export async function disposePet(panelId: string): Promise<void> {
  try {
    await window.electronAPI.agentDispose(panelId)
  } catch (err) {
    log.warn('[petSession] dispose failed for %s: %O', panelId, err)
  }
}
