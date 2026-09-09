import type { PullRequestItem } from '../../shared/pullRequests'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { checkoutPrForWorkspace } from '../stores/useWorktreeActions'
import { requestPanelTarget } from '../lib/panelTargetPicker'
import { openReviewPanel } from '../lib/review/openReviewPanel'

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
    useUIStore.getState().setShowPullRequests(false)
    const panels = Object.values(useAppStore.getState().getWorkspace(workspace.id)?.panels ?? {})
    if (!panels.some((panel) => panel.type === 'terminal' && panel.worktreeId === worktree.id)) {
      const target = await requestPanelTarget({ workspaceId: workspace.id, panelType: 'terminal', availability: 'new', source: 'overlay' })
      if (target?.kind !== 'new') return
      const terminal = store.createTerminal(workspace.id, undefined, undefined, target.placement, worktree.path)
      store.setPanelWorktreeId(workspace.id, terminal, worktree.id)
    }
    if (!panels.some((panel) => panel.type === 'agent' && panel.worktreeId === worktree.id)) {
      const target = await requestPanelTarget({ workspaceId: workspace.id, panelType: 'agent', availability: 'new', source: 'overlay' })
      if (target?.kind !== 'new') return
      store.createAgent(workspace.id, undefined, target.placement, worktree.path, worktree.id)
    }
    const review = await openReviewPanel({
      workspaceId: workspace.id, repoPath: worktree.path, source: 'overlay',
      spec: { kind: 'branch', base: context.baseOid, target: 'HEAD' },
    })
    if (review) store.updatePanelTitle(workspace.id, review, `#${pr.number} ${pr.title}`)
    return
  }
  throw new Error(`Open your local ${pr.repository} project in Cate first, then try again. Its origin remote must point to this GitHub repository.`)
}
