// Open recorded agent edits in a Review, without waiting on a workspace-info
// round trip before the new panel can show its loading state.

import { documentStoreFor } from '@client/document'
import { createPanel, revealPanel } from '@client/host'
import { runtimeFor } from '@kernel/rpc/client'
import type { AgentChangesFilter } from '@services/agents/contract'
import { peekAgentPanels } from '@services/agents/client'
import type { PanelId, PlaceTarget } from '@workspace/document/contract'
import { type ReviewCreateOptions, type ReviewOp, type ReviewOpenRequest } from '../contract'

function sendReviewOp(workspaceId: string, panelId: PanelId, op: ReviewOp): Promise<unknown> {
  return runtimeFor(workspaceId).session.op({ panelId, op })
}

function addReview(workspaceId: string, options: ReviewCreateOptions & { repoPath: string; request: ReviewOpenRequest }): PanelId | null {
  return createPanel(workspaceId, 'review', { ...options })
}

/** The checkout an agent works in: its session's, else its panel's
 *  worktree, else the workspace root. */
function knownAgentCheckout(workspaceId: string, panelId: PanelId): string | undefined {
  const session = peekAgentPanels(workspaceId)[panelId]?.session?.cwd
  if (session) return session
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const worktreeId = doc?.panels[panelId]?.worktreeId
  const worktree = worktreeId ? doc?.worktrees[worktreeId]?.path : undefined
  return worktree
}

export async function agentCheckout(workspaceId: string, panelId: PanelId): Promise<string> {
  return knownAgentCheckout(workspaceId, panelId) ?? (await runtimeFor(workspaceId).workspace.info()).root
}

export interface OpenAgentChangesOptions {
  workspaceId: string
  /** The terminal panel whose changes to show. */
  panelId: PanelId
  /** The checkout to show; default: the agent's (`agentCheckout`). */
  cwd?: string
  sessionId?: string
  turnId?: string
  focusedFile?: string
  /** A review panel to reuse instead of adding one. */
  reviewPanelId?: PanelId
  /** Where a new review goes; default: next to the agent's panel. */
  at?: PlaceTarget
}

/** Shows an agent's recorded edits: in `reviewPanelId` (moved to the agent's
 *  checkout), else in a new "Agent changes" review next to the agent. The
 *  review's id, or null when it could not be shown. */
export async function openAgentChanges(options: OpenAgentChangesOptions): Promise<PanelId | null> {
  const { workspaceId, panelId, focusedFile } = options
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  if (!doc?.panels[panelId]) return null
  const cwd = options.cwd ?? knownAgentCheckout(workspaceId, panelId)
  const agentChanges: AgentChangesFilter = {
    panelId,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.turnId ? { turnId: options.turnId } : {}),
  }
  const request: ReviewOpenRequest = { agentChanges, ...(focusedFile ? { focusedFile } : {}) }
  const target = options.reviewPanelId ? doc.panels[options.reviewPanelId] : undefined
  if (options.reviewPanelId) {
    if (target?.type !== 'review') return null
    if (!(await sendReviewOp(workspaceId, target.id, { kind: 'switchCheckout', path: cwd ?? await agentCheckout(workspaceId, panelId) }))) return null
    await sendReviewOp(workspaceId, target.id, { kind: 'retarget', request })
    void revealPanel(workspaceId, target.id)
    return target.id
  }
  return addReview(workspaceId, { repoPath: cwd ?? '', request, title: 'Agent changes', near: panelId, ...(options.at ? { at: options.at } : {}) })
}
