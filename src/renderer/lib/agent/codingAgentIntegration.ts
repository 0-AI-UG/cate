import type { ElectronAPI } from '../../../shared/electron-api'
import { useAppStore } from '../../stores/appStore'
import { gitStatusStore } from '../../stores/gitStatusStore'

export type CodingAgentWorktreeReview = Awaited<ReturnType<ElectronAPI['gitWorktreeReview']>>

function context(workspaceId: string, panelId: string) {
  const store = useAppStore.getState()
  const workspace = store.workspaces.find((candidate) => candidate.id === workspaceId)
  const panel = workspace?.panels[panelId]
  const run = panel?.codingAgentRun
  const worktree = workspace?.worktrees?.find((candidate) => candidate.id === run?.worktreeId)
  if (!workspace?.rootPath || !panel || !run) throw new Error('coding-agent-not-found')
  if (!worktree) throw new Error('coding-agent-not-isolated')
  return { store, workspace, panel, run, worktree }
}

export async function reviewCodingAgentWorktree(
  workspaceId: string,
  panelId: string,
): Promise<CodingAgentWorktreeReview> {
  const { workspace, worktree } = context(workspaceId, panelId)
  const primary = await window.electronAPI.gitStatus(workspace.rootPath, workspaceId)
  if (!primary.current) throw new Error('target-branch-not-found')
  return window.electronAPI.gitWorktreeReview(worktree.path, primary.current, workspaceId)
}

export async function applyCodingAgentWorktree(
  workspaceId: string,
  panelId: string,
  expectedBaseBranch?: string,
): Promise<{ ok: true; branch: string } | { ok: false; message: string }> {
  const { store, workspace, run } = context(workspaceId, panelId)
  const review = await reviewCodingAgentWorktree(workspaceId, panelId)
  if (!review.canApply) {
    return { ok: false, message: review.message ?? 'This worker is not ready to apply.' }
  }
  if (expectedBaseBranch && review.baseBranch !== expectedBaseBranch) {
    return {
      ok: false,
      message: `The current branch changed from ${expectedBaseBranch} to ${review.baseBranch}. Review again before applying.`,
    }
  }
  const result = await window.electronAPI.gitWorktreeMergeTo(
    workspace.rootPath,
    review.branch,
    review.baseBranch,
    workspaceId,
  )
  if (!result.ok) return { ok: false, message: result.message }
  store.setPanelCodingAgentRun(workspaceId, panelId, {
    ...run,
    appliedAt: Date.now(),
    appliedToBranch: review.baseBranch,
  })
  gitStatusStore.refresh(workspace.rootPath)
  return { ok: true, branch: review.baseBranch }
}

export function keepCodingAgentWorktree(workspaceId: string, panelId: string): void {
  const { store, run } = context(workspaceId, panelId)
  store.setPanelCodingAgentRun(workspaceId, panelId, {
    ...run,
    keptAt: Date.now(),
  })
}

export async function discardCodingAgentWorktree(
  workspaceId: string,
  panelId: string,
): Promise<void> {
  const { store, workspace, run, worktree } = context(workspaceId, panelId)
  if (!run.ownsWorktree) throw new Error('worker-does-not-own-worktree')
  const status = await window.electronAPI.gitWorktreeStatus(worktree.path, workspaceId)
  if (!status) throw new Error('worktree-not-found')
  await window.electronAPI.gitWorktreeRemove(
    workspace.rootPath,
    worktree.path,
    { force: status.dirty },
    workspaceId,
  )
  try {
    await window.electronAPI.gitBranchDelete(
      workspace.rootPath,
      status.branch,
      true,
      workspaceId,
    )
  } finally {
    store.removeWorktree(workspaceId, worktree.id)
    store.removeAdditionalRoot(workspaceId, worktree.path)
    store.setPanelCodingAgentRun(workspaceId, panelId, {
      ...run,
      worktreeId: undefined,
      ownsWorktree: false,
    })
    gitStatusStore.refresh(workspace.rootPath)
  }
}
