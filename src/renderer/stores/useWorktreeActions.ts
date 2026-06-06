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
import { gitStatusStore } from './gitStatusStore'
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

function makeWorktreeId(): string {
  return `wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export interface WorktreeActions {
  /** Create a brand-new branch + worktree. Throws on failure (callers surface). */
  createWorktree: (rawName: string, baseRef?: string) => Promise<void>
  /** Check out an existing pull request into its own worktree. */
  checkoutPr: (pr: PrListItem) => Promise<void>
}

export function useWorktreeActions(rootPath: string, workspaceId: string | null): WorktreeActions {
  const upsertWorktree = useAppStore((s) => s.upsertWorktree)
  const addAdditionalRoot = useAppStore((s) => s.addAdditionalRoot)

  const createWorktree = useCallback(
    async (rawName: string, baseRef?: string) => {
      if (!rootPath || !workspaceId) return
      const branch = toBranchName(rawName)
      if (!branch) throw new Error('Please enter a name')
      const targetPath = worktreePathFor(rootPath, branch)
      await window.electronAPI.gitWorktreeAdd(rootPath, branch, targetPath, {
        createBranch: true,
        baseRef,
      })

      const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
      const meta: WorktreeMeta = {
        id: makeWorktreeId(),
        path: targetPath,
        // Keep the friendly name when it differs from the slugged branch.
        label: rawName.trim() !== branch ? rawName.trim() : undefined,
        color: pickWorktreeColor(ws?.worktrees ?? []),
      }
      upsertWorktree(workspaceId, meta)
      addAdditionalRoot(workspaceId, targetPath)
      gitStatusStore.refresh(rootPath)
    },
    [rootPath, workspaceId, upsertWorktree, addAdditionalRoot],
  )

  const checkoutPr = useCallback(
    async (pr: PrListItem) => {
      if (!rootPath || !workspaceId) return
      // Slug includes the PR number so contributors' identically-named branches
      // never collide on disk.
      const targetPath = worktreePathFor(rootPath, `pr-${pr.number}-${pr.headRefName}`)
      const res = await window.electronAPI.gitWorktreeAddFromPr(rootPath, pr.number, targetPath)

      const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
      const meta: WorktreeMeta = {
        id: makeWorktreeId(),
        path: res.path,
        label: `#${pr.number} ${pr.headRefName}`,
        color: pickWorktreeColor(ws?.worktrees ?? []),
      }
      upsertWorktree(workspaceId, meta)
      addAdditionalRoot(workspaceId, res.path)
      gitStatusStore.refresh(rootPath)
    },
    [rootPath, workspaceId, upsertWorktree, addAdditionalRoot],
  )

  return { createWorktree, checkoutPr }
}
