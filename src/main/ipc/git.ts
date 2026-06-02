// =============================================================================
// Git IPC handlers — thin routers over the resolved companion's VcsHost.
//
// The git logic itself lives in ONE place: the electron-free factory
// `createVcsCapability` (src/companion/capabilities/vcs.ts). The local companion
// builds its vcs from that factory (see LocalCompanion.ts); the daemon builds
// the same factory with process.env. The handlers below parse the locator off
// the cwd-like argument, resolve the target companion, and delegate to
// `companion.vcs.<op>` — they contain no git logic.
// =============================================================================

import { ipcMain } from 'electron'
import { parseLocator } from '../companion/locator'
import { companions } from '../companion/companionManager'
import { localCompanion } from '../companion/LocalCompanion'
import {
  GIT_IS_REPO,
  GIT_INIT,
  GIT_LS_FILES,
  GIT_STATUS,
  GIT_DIFF,
  GIT_STAGE,
  GIT_UNSTAGE,
  GIT_COMMIT,
  GIT_WORKTREE_LIST,
  GIT_WORKTREE_ADD,
  GIT_WORKTREE_REMOVE,
  GIT_WORKTREE_PRUNE,
  GIT_WORKTREE_STATUS,
  GIT_WORKTREE_MERGE_TO,
  GIT_WORKTREE_ADD_FROM_PR,
  GIT_WORKTREE_UPDATE_FROM,
  GIT_CREATE_PR,
  GIT_PR_STATUS,
  GIT_PR_LIST,
  GIT_PUSH,
  GIT_PULL,
  GIT_FETCH,
  GIT_LOG,
  GIT_BRANCH_LIST,
  GIT_BRANCH_CREATE,
  GIT_BRANCH_DELETE,
  GIT_CHECKOUT,
  GIT_DIFF_STAGED,
  GIT_STASH,
  GIT_STASH_POP,
  GIT_DISCARD_FILE,
} from '../../shared/ipc-channels'

/**
 * Create a local branch, optionally from an explicit start point. Thin
 * back-compat wrapper over the single vcs implementation (the logic lives in
 * `createVcsCapability().branchCreate`) — kept exported for the git tests.
 */
export async function createBranch(cwd: string, branchName: string, startPoint?: string): Promise<void> {
  return localCompanion.vcs.branchCreate(cwd, branchName, startPoint)
}

// =============================================================================
// IPC handlers — thin routers: parse the locator off the cwd-like argument,
// resolve the target companion, delegate to its VcsHost.
// =============================================================================

/** Resolve the VcsHost for a cwd-bearing locator, returning it plus the path. */
function vcsFor(locator: string): { vcs: import('../companion/types').VcsHost; path: string } {
  const { companionId, path: p } = parseLocator(locator)
  return { vcs: companions.resolve(companionId).vcs, path: p }
}

export function registerHandlers(): void {
  ipcMain.handle(GIT_IS_REPO, async (_event, dirPath: string) => {
    const { vcs, path } = vcsFor(dirPath)
    return vcs.isRepo(path)
  })

  ipcMain.handle(GIT_INIT, async (_event, dirPath: string) => {
    const { vcs, path } = vcsFor(dirPath)
    return vcs.init(path)
  })

  ipcMain.handle(GIT_LS_FILES, async (_event, dirPath: string) => {
    const { vcs, path } = vcsFor(dirPath)
    return vcs.lsFiles(path)
  })

  ipcMain.handle(GIT_STATUS, async (_event, cwd: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.status(path)
  })

  ipcMain.handle(GIT_DIFF, async (_event, cwd: string, filePath?: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.diff(path, filePath)
  })

  ipcMain.handle(GIT_STAGE, async (_event, cwd: string, filePath: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.stage(path, filePath)
  })

  ipcMain.handle(GIT_UNSTAGE, async (_event, cwd: string, filePath: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.unstage(path, filePath)
  })

  ipcMain.handle(GIT_COMMIT, async (_event, cwd: string, message: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.commit(path, message)
  })

  ipcMain.handle(GIT_PUSH, async (_event, cwd: string, remote?: string, branch?: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.push(path, remote, branch)
  })

  ipcMain.handle(GIT_PULL, async (_event, cwd: string, remote?: string, branch?: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.pull(path, remote, branch)
  })

  ipcMain.handle(GIT_FETCH, async (_event, cwd: string, remote?: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.fetch(path, remote)
  })

  ipcMain.handle(GIT_LOG, async (_event, cwd: string, maxCount?: number) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.log(path, maxCount)
  })

  ipcMain.handle(GIT_BRANCH_LIST, async (_event, cwd: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.branchList(path)
  })

  ipcMain.handle(GIT_BRANCH_CREATE, async (_event, cwd: string, branchName: string, startPoint?: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.branchCreate(path, branchName, startPoint)
  })

  ipcMain.handle(GIT_BRANCH_DELETE, async (_event, cwd: string, branchName: string, force?: boolean) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.branchDelete(path, branchName, force)
  })

  ipcMain.handle(GIT_CHECKOUT, async (_event, cwd: string, branchName: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.checkout(path, branchName)
  })

  ipcMain.handle(GIT_DIFF_STAGED, async (_event, cwd: string, filePath?: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.diffStaged(path, filePath)
  })

  ipcMain.handle(GIT_STASH, async (_event, cwd: string, message?: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.stash(path, message)
  })

  ipcMain.handle(GIT_STASH_POP, async (_event, cwd: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.stashPop(path)
  })

  ipcMain.handle(GIT_DISCARD_FILE, async (_event, cwd: string, filePath: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.discardFile(path, filePath)
  })

  ipcMain.handle(GIT_WORKTREE_LIST, async (_event, cwd: string) => {
    const { vcs, path } = vcsFor(cwd)
    return vcs.worktreeList(path)
  })

  ipcMain.handle(
    GIT_WORKTREE_ADD,
    async (
      _event,
      repoCwd: string,
      branch: string,
      targetPath: string,
      options?: { createBranch?: boolean; baseRef?: string },
    ) => {
      const { vcs, path } = vcsFor(repoCwd)
      return vcs.worktreeAdd(path, branch, targetPath, options)
    },
  )

  ipcMain.handle(
    GIT_WORKTREE_ADD_FROM_PR,
    async (_event, repoCwd: string, prNumber: number, targetPath: string) => {
      const { vcs, path } = vcsFor(repoCwd)
      return vcs.worktreeAddFromPr(path, prNumber, targetPath)
    },
  )

  ipcMain.handle(
    GIT_WORKTREE_REMOVE,
    async (_event, repoCwd: string, worktreePath: string, options?: { force?: boolean }) => {
      const { vcs, path } = vcsFor(repoCwd)
      return vcs.worktreeRemove(path, worktreePath, options)
    },
  )

  ipcMain.handle(GIT_WORKTREE_PRUNE, async (_event, repoCwd: string) => {
    const { vcs, path } = vcsFor(repoCwd)
    return vcs.worktreePrune(path)
  })

  ipcMain.handle(GIT_WORKTREE_STATUS, async (_event, worktreePath: string) => {
    const { vcs, path } = vcsFor(worktreePath)
    return vcs.worktreeStatus(path)
  })

  ipcMain.handle(GIT_WORKTREE_MERGE_TO, async (_event, repoCwd: string, fromBranch: string, toBranch: string) => {
    const { vcs, path } = vcsFor(repoCwd)
    return vcs.worktreeMergeTo(path, fromBranch, toBranch)
  })

  ipcMain.handle(GIT_WORKTREE_UPDATE_FROM, async (_event, worktreePath: string, fromBranch: string) => {
    const { vcs, path } = vcsFor(worktreePath)
    return vcs.worktreeUpdateFrom(path, fromBranch)
  })

  ipcMain.handle(GIT_CREATE_PR, async (_event, worktreePath: string, branch: string) => {
    const { vcs, path } = vcsFor(worktreePath)
    return vcs.createPr(path, branch)
  })

  ipcMain.handle(GIT_PR_STATUS, async (_event, worktreePath: string, branch: string) => {
    const { vcs, path } = vcsFor(worktreePath)
    return vcs.prStatus(path, branch)
  })

  ipcMain.handle(GIT_PR_LIST, async (_event, repoCwd: string) => {
    const { vcs, path } = vcsFor(repoCwd)
    return vcs.prList(path)
  })
}
