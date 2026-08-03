// =============================================================================
// useWorktreeActions — the git + store side of starting a parallel branch.
//
// Extracted from ParallelWorkTab so the sidebar and the canvas toolbar's
// worktree drop-up create worktrees through one code path: add the worktree on
// disk, persist its UI metadata (id/color/label), register it as an additional
// root, then re-arm the shared git status store so every view updates.
// =============================================================================

import { useCallback } from 'react'
import { useAppStore, pickWorktreeColor } from './appStore'
import { useSettingsStore } from './settingsStore'
import { gitStatusStore } from './gitStatusStore'
import { newWorktreeId } from '../lib/worktreeSync'
import type { WorktreeMeta } from '../../shared/types'
import type { PrListItem } from '../sidebar/CreateWorktreeForm'

/** Worktrees live inside the project at <repo>/.cate/worktrees/<branch-slug>.
 *  The worktree-add handler drops a `*` .gitignore in that folder so the
 *  checkouts never show up as untracked noise in the parent repo. */
function worktreePathFor(repoRoot: string, branch: string): string {
  const trimmed = repoRoot.replace(/[/\\]+$/, '')
  const slug = branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'wt'
  return `${trimmed}/.cate/worktrees/${slug}`
}

/** Turn free-text ("fix the login bug") into a valid branch name
 *  ("fix-the-login-bug") while leaving deliberate branch paths ("feat/x") be. */
function toBranchName(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w./-]+/g, '')
    .replace(/^-+|-+$/g, '')
}

/** Workspace-root-relative paths to symlink into a new worktree, or undefined
 *  when none are configured. Global setting, applied to every workspace. */
function configuredSymlinkPaths(): string[] | undefined {
  const paths = useSettingsStore.getState().worktreeSymlinkPaths.map((p) => p.trim()).filter(Boolean)
  return paths.length ? paths : undefined
}

export interface WorktreeActions {
  /** Create a brand-new branch + worktree. Throws on failure (callers surface).
   *  Returns the registered metadata (null when there is no workspace/root yet) so
   *  a caller can select what it just created. */
  createWorktree: (rawName: string, baseRef?: string) => Promise<WorktreeMeta | null>
  /** Check out an existing pull request into its own worktree. */
  checkoutPr: (pr: PrListItem) => Promise<WorktreeMeta | null>
}

/** Imperative core shared by the React hook and Cate Agent's orchestration
 * driver. Keeping one path preserves branch sanitization, symlink settings,
 * metadata colors, additional-root registration, and git refresh behavior. */
export async function createWorktreeForWorkspace(
  rootPath: string,
  workspaceId: string,
  rawName: string,
  baseRef?: string,
): Promise<WorktreeMeta> {
  const branch = toBranchName(rawName)
  if (!branch) throw new Error('Please enter a name')
  const targetPath = worktreePathFor(rootPath, branch)
  await window.electronAPI.gitWorktreeAdd(rootPath, branch, targetPath, {
    createBranch: true,
    baseRef,
    symlinkPaths: configuredSymlinkPaths(),
  }, workspaceId)

  const store = useAppStore.getState()
  const ws = store.workspaces.find((workspace) => workspace.id === workspaceId)
  const meta: WorktreeMeta = {
    id: newWorktreeId(),
    path: targetPath,
    label: rawName.trim() !== branch ? rawName.trim() : undefined,
    color: pickWorktreeColor(ws?.worktrees ?? []),
  }
  store.upsertWorktree(workspaceId, meta)
  store.addAdditionalRoot(workspaceId, targetPath)
  gitStatusStore.refresh(rootPath)
  return meta
}

/** Roll back a worktree created for a worker that failed preflight before its
 * terminal could start. The checkout must be removed before its branch can be
 * deleted; renderer metadata is cleared once the checkout is gone even when
 * branch deletion itself fails. */
export async function discardCreatedWorktreeForWorkspace(
  rootPath: string,
  workspaceId: string,
  rawName: string,
  worktree: WorktreeMeta,
): Promise<void> {
  const branch = toBranchName(rawName)
  await window.electronAPI.gitWorktreeRemove(
    rootPath,
    worktree.path,
    { force: true },
    workspaceId,
  )

  try {
    await window.electronAPI.gitBranchDelete(rootPath, branch, true, workspaceId)
  } finally {
    const store = useAppStore.getState()
    store.removeWorktree(workspaceId, worktree.id)
    store.removeAdditionalRoot(workspaceId, worktree.path)
    gitStatusStore.refresh(rootPath)
  }
}

export function useWorktreeActions(rootPath: string, workspaceId: string | null): WorktreeActions {
  const upsertWorktree = useAppStore((s) => s.upsertWorktree)
  const addAdditionalRoot = useAppStore((s) => s.addAdditionalRoot)

  const createWorktree = useCallback(
    async (rawName: string, baseRef?: string) => {
      if (!rootPath || !workspaceId) return null
      return createWorktreeForWorkspace(rootPath, workspaceId, rawName, baseRef)
    },
    [rootPath, workspaceId],
  )

  const checkoutPr = useCallback(
    async (pr: PrListItem) => {
      if (!rootPath || !workspaceId) return null
      // Slug includes the PR number so contributors' identically-named branches
      // never collide on disk.
      const targetPath = worktreePathFor(rootPath, `pr-${pr.number}-${pr.headRefName}`)
      const res = await window.electronAPI.gitWorktreeAddFromPr(rootPath, pr.number, targetPath, {
        symlinkPaths: configuredSymlinkPaths(),
      }, workspaceId)

      const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
      const meta: WorktreeMeta = {
        id: newWorktreeId(),
        path: res.path,
        label: `#${pr.number} ${pr.headRefName}`,
        prNumber: pr.number,
        color: pickWorktreeColor(ws?.worktrees ?? []),
      }
      upsertWorktree(workspaceId, meta)
      addAdditionalRoot(workspaceId, res.path)
      gitStatusStore.refresh(rootPath)
      return meta
    },
    [rootPath, workspaceId, upsertWorktree, addAdditionalRoot],
  )

  return { createWorktree, checkoutPr }
}
