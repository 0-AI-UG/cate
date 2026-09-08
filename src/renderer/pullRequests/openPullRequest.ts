import type { PullRequestItem } from '../../shared/pullRequests'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { checkoutPrForWorkspace } from '../stores/useWorktreeActions'
import { getWorkspaceCanvasPanelId } from '../lib/workspace/canvasAccess'
import { revealPanel } from '../lib/workspace/panelReveal'

export async function openPullRequest(pr: PullRequestItem): Promise<void> {
  const store = useAppStore.getState()
  const workspaces = [...store.workspaces].sort((a, b) => Number(b.id === store.selectedWorkspaceId) - Number(a.id === store.selectedWorkspaceId))
  for (const workspace of workspaces) {
    if (!workspace.rootPath || workspace.rootPath.startsWith('cate-runtime://')) continue
    const context = await window.electronAPI.githubPrContext(workspace.id, pr.repository, pr.number)
    if (!context) continue
    const worktree = workspace.worktrees?.find((wt) => wt.prNumber === pr.number) ?? await checkoutPrForWorkspace(workspace.rootPath, workspace.id, {
      number: pr.number, title: pr.title, headRefName: context.headRefName, author: pr.author, isFork: false,
    })
    await store.selectWorkspace(workspace.id)
    store.ensureCenterCanvas(workspace.id)
    const canvasPanelId = getWorkspaceCanvasPanelId(workspace.id)
    if (!canvasPanelId) throw new Error('Could not open the workspace canvas. Try again.')
    const placement = { target: 'canvas' as const, canvasPanelId }
    const panels = Object.values(useAppStore.getState().getWorkspace(workspace.id)?.panels ?? {})
    if (!panels.some((panel) => panel.type === 'terminal' && panel.worktreeId === worktree.id)) {
      const terminal = store.createTerminal(workspace.id, undefined, undefined, placement, worktree.path)
      store.setPanelWorktreeId(workspace.id, terminal, worktree.id)
    }
    if (!panels.some((panel) => panel.type === 'agent' && panel.worktreeId === worktree.id)) {
      store.createAgent(workspace.id, undefined, placement, worktree.path, worktree.id)
    }
    const existing = panels.find((panel) => panel.type === 'review' && panel.reviewState?.repoPath === worktree.path)
    const review = existing?.id ?? store.createReview(workspace.id, worktree.path, {
      spec: { kind: 'branch', base: context.baseOid, target: 'HEAD' },
    }, undefined, placement)
    if (existing?.reviewState) store.setPanelReviewState(workspace.id, review, {
      ...existing.reviewState, spec: { kind: 'branch', base: context.baseOid, target: 'HEAD' },
    })
    store.updatePanelTitle(workspace.id, review, `#${pr.number} ${pr.title}`)
    useUIStore.getState().setShowPullRequests(false)
    await revealPanel(workspace.id, review, { retry: true })
    return
  }
  throw new Error(`Open your local ${pr.repository} project in Cate first, then try again. Its origin remote must point to this GitHub repository.`)
}
