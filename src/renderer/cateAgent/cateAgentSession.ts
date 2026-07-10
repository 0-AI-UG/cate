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
import { agentClient } from '../../agent/renderer/agentClient'

/** panelId for the always-on observer of a workspace. */
export function observerPanelId(wsId: string): string {
  return `cate-agent-observer:${wsId}`
}

/** panelId for the ephemeral orchestrator of a single todo. */
export function orchestratorPanelId(todoId: string): string {
  return `cate-agent-orchestrator:${todoId}`
}

/** panelId for the per-iteration driver session. Keyed by an arbitrary string (the
 *  iteration id for a work driver, or `<iterationId>-verify` for the verifier) so
 *  each driver gets a distinct, stable id. */
export function driverPanelId(key: string): string {
  return `cate-agent-driver:${key}`
}

/** panelId for an ephemeral canvas subagent session (one per orchestrator `canvas`
 *  call), keyed by an arbitrary unique string. */
export function canvasPanelId(key: string): string {
  return `cate-agent-canvas:${key}`
}

/** True for any Cate Agent session panelId (used to route agent events to the bridge). */
export function isCateAgentPanelId(panelId: string): boolean {
  return (
    panelId.startsWith('cate-agent-observer:') ||
    panelId.startsWith('cate-agent-orchestrator:') ||
    panelId.startsWith('cate-agent-driver:') ||
    panelId.startsWith('cate-agent-canvas:')
  )
}

/** Resolve the Cate Agent model from settings, falling back to the global default.
 *  null ⇒ undefined so pi picks its own first-available model. Both roles share it. */
function cateAgentModel(): AgentModelRef | undefined {
  return loadCateAgentModel() ?? loadDefaultModel() ?? undefined
}

// Role framing (system prompt) + read-only tool gating are injected by the
// cate-agent-tools extension via its `before_agent_start` handler, keyed off
// CATE_AGENT_ROLE — that's the only place the role's behavior is defined, and the
// only one that reaches pi (AgentCreateOptions.systemPrompt is not plumbed to it).

export interface CreateCateAgentSessionOpts {
  panelId: string
  /** Workspace locator (rootPath) used as the agent cwd. */
  rootPath: string
  workspaceId: string
  role: CateAgentRole
  /** cwd override — the verifier runs in its target worktree, not the root. */
  cwd?: string
}

/** Start a headless Cate Agent session. Returns false if creation failed. */
export async function createCateAgentSession(opts: CreateCateAgentSessionOpts): Promise<boolean> {
  try {
    const res = await agentClient.create({
      panelId: opts.panelId,
      workspaceId: opts.workspaceId,
      cwd: opts.cwd ?? opts.rootPath,
      model: cateAgentModel(),
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
    await agentClient.prompt(panelId, text)
  } catch (err) {
    log.warn('[cateAgentSession] prompt failed for %s: %O', panelId, err)
  }
}

export async function interruptCateAgent(panelId: string): Promise<void> {
  try {
    await agentClient.interrupt(panelId)
  } catch (err) {
    log.warn('[cateAgentSession] interrupt failed for %s: %O', panelId, err)
  }
}

export async function disposeCateAgent(panelId: string): Promise<void> {
  try {
    await agentClient.dispose(panelId)
  } catch (err) {
    log.warn('[cateAgentSession] dispose failed for %s: %O', panelId, err)
  }
}
