// What the repository flows and views need from the client that shows them:
// the current workspace, its document data (worktree metadata, panels) and
// the client actions that open or switch panels. The workspace layer may not
// import the client layer, so the client fills it.

import type { IconName } from '@kernel/interaction/contract'
import type { PanelRecord, WorktreeMeta } from '@workspace/document/contract'
import type { GitComparisonSpec, JoinedWorktree } from '../contract'

/** A panel type created in a checkout (its definition's
 *  `creation.inWorktree`): the worktree menu offers one launch button each. */
export interface WorktreeLaunchType {
  type: string
  label: string
  icon: IconName
  /** Runs live in the checkout (`switchesWorktree`): a checked-out pull
   *  request opens one of each. */
  switches: boolean
}

export interface ReviewRequest {
  repoPath: string
  spec: GitComparisonSpec
  focusedFile?: string
  openNew?: boolean
  /** Title for the review panel (a PR opened in Cate). */
  title?: string
}

export interface RepositoryHost {
  workspaceId: string
  /** Canonical workspace root. */
  root: string
  /** The document's worktree metadata. */
  worktrees: readonly WorktreeMeta[]
  /** The document's panel records. */
  panels: readonly PanelRecord[]
  /** The panel types a worktree can be launched in, in menu order. */
  launchTypes: readonly WorktreeLaunchType[]
  /** Writes one worktree's metadata (`setWorktree`). */
  setWorktree(meta: WorktreeMeta): void
  /** Opens a panel of one of `launchTypes` bound to the checkout. `canvasPanelId` pins it to
   *  that canvas; otherwise the client places it (and may ask). Resolves false
   *  when the person cancelled. */
  launchInWorktree(worktree: Pick<JoinedWorktree, 'id' | 'path'>, type: string, opts?: { canvasPanelId?: string }): Promise<boolean>
  /** Bound panels the runtime will close with the worktree, for the warning. */
  worktreePanelSummary(worktreeId: string): { count: number; hasDirtyEditor: boolean }
  /** Asks about unsaved work in the worktree's panels before removal. False
   *  cancels. */
  prepareWorktreeClose(worktreeId: string): Promise<boolean>
  /** Whether the panel's type switches checkouts live (its definition's
   *  `switchesWorktree`): only those show the worktree switcher. */
  switchesWorktree(panel: PanelRecord): boolean
  /** Rebinds a panel to another checkout (asks about a running process first). */
  switchPanelWorktree(panelId: string, worktreeId: string): Promise<void>
  openReview(request: ReviewRequest): Promise<void>
  /** The canvas lens: the worktree focused on the canvas and the hovered one. */
  focusedWorktreeId: string | null
  focusWorktree(worktreeId: string | null): void
  setHoveredWorktree(worktreeId: string | null): void
}
