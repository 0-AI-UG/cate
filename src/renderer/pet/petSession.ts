// =============================================================================
// petSession — thin wrappers over the agent IPC for the pet's HEADLESS sessions.
//
// Pet sessions reuse the normal pi-agent machinery but are keyed with a `pet-`
// panelId and never get an AgentPanel: agentStore routes their events to the pet
// bridge instead (see petBridge wiring in agentStore). The role is passed to pi
// via CATE_PET_ROLE so the cate-pet-tools extension registers the right tools.
// =============================================================================

import type { AgentModelRef, PetRole } from '../../shared/types'
import { loadDefaultModel, loadPetObserverModel, loadPetExecutorModel } from '../../agent/renderer/agentModelPrefs'
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

/** Resolve the model for a role from settings, falling back to the default. null
 *  ⇒ undefined so pi picks its own first-available model. */
function modelForRole(role: PetRole): AgentModelRef | undefined {
  const pinned = role === 'observer' ? loadPetObserverModel() : loadPetExecutorModel()
  return pinned ?? loadDefaultModel() ?? undefined
}

const OBSERVER_SYSTEM_PROMPT = [
  'You are the Canvas Pet OBSERVER for a coding workspace.',
  'Watch what the user is doing and propose tasks sparingly, only with a clear, specific rationale grounded in their real activity (use get_user_activity, list_terminals, read_terminal).',
  'NEVER act, edit, or run anything — you only propose via propose_todo. Check list_todos first and never duplicate an existing todo (suggested, pending, in progress, or done).',
  'If nothing is clearly worth proposing, do nothing and end your turn.',
].join(' ')

const EXECUTOR_SYSTEM_PROMPT = [
  'You are the Canvas Pet ORCHESTRATOR. You carry out ONE approved todo by DELEGATING, never by doing the work yourself.',
  'You do NOT write code, edit files, or run build/test/lint commands directly. Instead you spawn a CODING-AGENT CLI inside a visible terminal (create_terminal) and DRIVE it: give it the task, answer its prompts with send_keys, and monitor it with read_terminal / wait_for_terminal.',
  'Your ONLY direct actions are the orchestration tools: create_worktree, set_plan, create_terminal, send_keys, read_terminal, wait_for_terminal, close_terminal, update_todo. The terminal agent does ALL real work (writing code, running tests, committing).',
  'Flow: create_worktree → set_plan → create_terminal launching the coding-agent CLI with the task as its prompt → drive/monitor until it reports the work done and verified → update_todo status "review". Do NOT merge or push. If it cannot be done, update_todo status "failed" with a short note.',
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
      model: modelForRole(opts.role),
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
