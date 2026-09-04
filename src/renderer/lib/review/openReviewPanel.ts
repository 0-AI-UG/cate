import type { GitComparisonSpec, ReviewPanelOpenRequest, ReviewPanelState } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { useWindowPanelStore } from '../../stores/windowPanelStore'
import { getActivePanelId } from '../activePanel'
import { placementForActivePanel, placementForPanel } from '../workspace/canvasAccess'
import { revealPanel } from '../workspace/panelReveal'

export interface OpenReviewOptions {
  workspaceId: string
  repoPath: string
  spec: GitComparisonSpec
  focusedFile?: string
  openNew?: boolean
  sourceAgent?: ReviewPanelState['sourceAgent']
}

function openRequest(options: OpenReviewOptions): ReviewPanelOpenRequest {
  return {
    spec: options.spec,
    focusedFile: options.focusedFile,
    sourceAgent: options.sourceAgent,
  }
}

function nextReviewState(
  current: ReviewPanelState,
  request: ReviewPanelOpenRequest,
): ReviewPanelState {
  const sourceChanged = request.sourceAgent?.runId !== current.sourceAgent?.runId
  return {
    ...current,
    spec: request.spec,
    focusedFile: request.focusedFile,
    sourceAgent: request.sourceAgent,
    agentReview: sourceChanged ? undefined : current.agentReview,
    collapsedFiles: request.focusedFile
      ? (current.collapsedFiles ?? []).filter((path) => path !== request.focusedFile)
      : current.collapsedFiles,
  }
}

/** Merge an open/deep-link request in the renderer that owns the Review panel. */
export async function retargetReviewPanel(
  workspaceId: string,
  panelId: string,
  request: ReviewPanelOpenRequest,
): Promise<boolean> {
  const app = useAppStore.getState()
  const panel = app.getWorkspace(workspaceId)?.panels[panelId]
  if (panel?.type !== 'review' || !panel.reviewState) return false
  app.setPanelReviewState(workspaceId, panelId, nextReviewState(panel.reviewState, request))
  await revealPanel(workspaceId, panelId, { retry: true })
  return true
}

/** Open a review comparison, reusing the active or newest panel for the same repo. */
export async function openReviewPanel(options: OpenReviewOptions): Promise<string> {
  const app = useAppStore.getState()
  const workspace = app.getWorkspace(options.workspaceId)
  const activeId = getActivePanelId()
  const matching = Object.values(workspace?.panels ?? {}).filter(
    (panel) => panel.type === 'review' && panel.reviewState?.repoPath === options.repoPath,
  )
  const active = matching.find((panel) => panel.id === activeId)
  const existing = options.openNew ? undefined : active ?? matching[matching.length - 1]
  const request = openRequest(options)

  if (existing) {
    await retargetReviewPanel(options.workspaceId, existing.id, request)
    return existing.id
  }

  if (!options.openNew) {
    const detached = useWindowPanelStore.getState().panels.filter(
      (panel) => panel.workspaceId === options.workspaceId
        && panel.type === 'review'
        && panel.reviewRepoPath === options.repoPath,
    ).at(-1)
    if (detached && await window.electronAPI.openWindowReviewPanel(detached.panelId, request)) {
      return detached.panelId
    }
  }

  const placement = (options.sourceAgent?.panelId
    ? placementForPanel(options.workspaceId, options.sourceAgent.panelId)
    : undefined) ?? placementForActivePanel()
  const panelId = app.createReview(options.workspaceId, options.repoPath, {
    spec: options.spec,
    focusedFile: options.focusedFile,
    sourceAgent: options.sourceAgent,
  }, undefined, placement)
  await revealPanel(options.workspaceId, panelId, { retry: true })
  return panelId
}
