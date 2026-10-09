// Client-side "open a review" and "open agent changes": reuse a review panel
// the document already has for the checkout (retargeted through its session
// op), or add one next to the panel the request came from.

import { clientStateFor, documentStoreFor } from '@client/document'
import { createPanel, revealPanel } from '@client/host'
import { runtimeFor } from '@kernel/rpc/client'
import type { AgentChangesFilter } from '@services/agents/contract'
import type { PanelId, PanelRecord, PlaceTarget, WorkspaceDocument } from '@workspace/document/contract'
import { samePath, type GitComparisonSpec } from '@workspace/repository/contract'
import { reviewRepoPath, type ReviewCreateOptions, type ReviewOp, type ReviewOpenRequest, type ReviewSourceAgent } from '../contract'

function sendReviewOp(workspaceId: string, panelId: PanelId, op: ReviewOp): Promise<unknown> {
  return runtimeFor(workspaceId).session.op({ panelId, op })
}

function reviewsOf(doc: WorkspaceDocument, repoPath: string): PanelRecord[] {
  return Object.values(doc.panels).filter((panel) => panel.type === 'review' && samePath(reviewRepoPath(panel.fields), repoPath))
}

function addReview(workspaceId: string, options: ReviewCreateOptions & { repoPath: string; request: ReviewOpenRequest }): PanelId | null {
  return createPanel(workspaceId, 'review', { ...options })
}

export interface OpenReviewOptions {
  workspaceId: string
  repoPath: string
  spec: GitComparisonSpec
  focusedFile?: string
  /** Always a new panel. */
  openNew?: boolean
  sourceAgent?: ReviewSourceAgent
}

/** Reuses the focused (else the newest) review of the checkout, or adds one
 *  next to the source agent or the focused panel. */
export async function openReviewPanel(options: OpenReviewOptions): Promise<PanelId | null> {
  const { workspaceId } = options
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  if (!doc) return null
  const focused = clientStateFor(workspaceId)?.getSnapshot().focusedPanelId ?? null
  const request: ReviewOpenRequest = {
    spec: options.spec,
    ...(options.focusedFile ? { focusedFile: options.focusedFile } : {}),
    ...(options.sourceAgent ? { sourceAgent: options.sourceAgent } : {}),
  }
  const matching = reviewsOf(doc, options.repoPath)
  const existing = options.openNew ? undefined : matching.find((panel) => panel.id === focused) ?? matching.at(-1)
  if (existing) {
    await sendReviewOp(workspaceId, existing.id, { kind: 'retarget', request })
    void revealPanel(workspaceId, existing.id)
    return existing.id
  }
  const near = options.sourceAgent?.panelId ?? focused
  return addReview(workspaceId, { repoPath: options.repoPath, request, ...(near ? { near } : {}) })
}

export interface OpenAgentChangesOptions {
  workspaceId: string
  /** The terminal or chat panel whose changes to show. */
  panelId: PanelId
  cwd: string
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
  const { workspaceId, panelId, cwd, focusedFile } = options
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  if (!doc?.panels[panelId]) return null
  const agentChanges: AgentChangesFilter = {
    panelId,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.turnId ? { turnId: options.turnId } : {}),
  }
  const request: ReviewOpenRequest = { spec: { kind: 'uncommitted' }, agentChanges, ...(focusedFile ? { focusedFile } : {}) }
  const target = options.reviewPanelId ? doc.panels[options.reviewPanelId] : undefined
  if (options.reviewPanelId) {
    if (target?.type !== 'review') return null
    if (!(await sendReviewOp(workspaceId, target.id, { kind: 'switchCheckout', path: cwd }))) return null
    await sendReviewOp(workspaceId, target.id, { kind: 'retarget', request })
    void revealPanel(workspaceId, target.id)
    return target.id
  }
  return addReview(workspaceId, { repoPath: cwd, request, title: 'Agent changes', ...(options.at ? { at: options.at } : { near: panelId }) })
}
