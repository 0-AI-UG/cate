// Client-side "open a review" and "open agent changes": reuse a review panel
// the document already has for the checkout (retargeted through its session
// op), or add one next to the panel the request came from.

import { clientStateFor, documentStoreFor } from '@client/document'
import { runtimeFor } from '@kernel/rpc/client'
import type { AgentChangesFilter } from '@services/agents/contract'
import {
  MAIN_WINDOW,
  placementOf,
  stacksIn,
  type PanelId,
  type PanelRecord,
  type PlaceTarget,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import { samePath, type GitComparisonSpec } from '@workspace/repository/contract'
import { freshRecord } from '@panels/definitions'
import { reviewRepoPath, type ReviewOp, type ReviewOpenRequest, type ReviewSourceAgent } from '@panels/review/contract'

const newId = () => globalThis.crypto.randomUUID()

/** A tab next to `near` (in its stack, or its canvas node's stack), else the
 *  main window's first stack. */
export function placeNear(doc: WorkspaceDocument, near: PanelId | null | undefined): PlaceTarget {
  const placement = near ? placementOf(doc, near) : null
  if (placement) return { to: 'stack', dock: placement.dock, stackId: placement.stackId, after: near }
  const main = { windowId: MAIN_WINDOW }
  const first = stacksIn(doc, main)[0]
  return { to: 'stack', dock: main, stackId: first?.id ?? newId() }
}

/** Shows a panel on this client: its tab becomes active and it takes focus. */
export function revealPanel(workspaceId: string, panelId: PanelId): void {
  const state = clientStateFor(workspaceId)
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const placement = doc ? placementOf(doc, panelId) : null
  if (!state) return
  if (placement) state.setActiveTab(placement.stackId, panelId)
  state.focus(panelId)
}

function sendReviewOp(workspaceId: string, panelId: PanelId, op: ReviewOp): Promise<unknown> {
  return runtimeFor(workspaceId).session.op({ panelId, op })
}

function reviewsOf(doc: WorkspaceDocument, repoPath: string): PanelRecord[] {
  return Object.values(doc.panels).filter((panel) => panel.type === 'review' && samePath(reviewRepoPath(panel.fields), repoPath))
}

function addReview(workspaceId: string, options: { repoPath: string; request: ReviewOpenRequest; near?: PanelId | null; title?: string }): PanelId | null {
  const store = documentStoreFor(workspaceId)
  if (!store) return null
  const doc = store.getSnapshot()
  const record = freshRecord(doc, 'review', { repoPath: options.repoPath, request: options.request, title: options.title })
  if (!record) return null
  const result = store.propose({ kind: 'addPanel', record, at: placeNear(doc, options.near) })
  if (!result.ok) return null
  revealPanel(workspaceId, record.id)
  return record.id
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
    revealPanel(workspaceId, existing.id)
    return existing.id
  }
  return addReview(workspaceId, { repoPath: options.repoPath, request, near: options.sourceAgent?.panelId ?? focused })
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
}

/** Shows an agent's recorded edits: in `reviewPanelId` (moved to the agent's
 *  checkout), else in a new "Agent changes" review next to the agent. */
export async function openAgentChanges(options: OpenAgentChangesOptions): Promise<boolean> {
  const { workspaceId, panelId, cwd, focusedFile } = options
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  if (!doc?.panels[panelId]) return false
  const agentChanges: AgentChangesFilter = {
    panelId,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.turnId ? { turnId: options.turnId } : {}),
  }
  const request: ReviewOpenRequest = { spec: { kind: 'uncommitted' }, agentChanges, ...(focusedFile ? { focusedFile } : {}) }
  const target = options.reviewPanelId ? doc.panels[options.reviewPanelId] : undefined
  if (options.reviewPanelId) {
    if (target?.type !== 'review') return false
    if (!(await sendReviewOp(workspaceId, target.id, { kind: 'switchCheckout', path: cwd }))) return false
    await sendReviewOp(workspaceId, target.id, { kind: 'retarget', request })
    revealPanel(workspaceId, target.id)
    return true
  }
  return addReview(workspaceId, { repoPath: cwd, request, near: panelId, title: 'Agent changes' }) !== null
}
