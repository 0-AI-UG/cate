import type { GitComparisonSpec, ReviewPanelState } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { getActivePanelId } from '../activePanel'
import { revealPanel } from '../workspace/panelReveal'

export interface OpenReviewOptions {
  workspaceId: string
  repoPath: string
  spec: GitComparisonSpec
  focusedFile?: string
  openNew?: boolean
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

  if (existing?.reviewState) {
    const next: ReviewPanelState = {
      ...existing.reviewState,
      spec: options.spec,
      focusedFile: options.focusedFile,
      collapsedFiles: options.focusedFile
        ? (existing.reviewState.collapsedFiles ?? []).filter((path) => path !== options.focusedFile)
        : existing.reviewState.collapsedFiles,
    }
    app.setPanelReviewState(options.workspaceId, existing.id, next)
    await revealPanel(options.workspaceId, existing.id, { retry: true })
    return existing.id
  }

  const panelId = app.createReview(options.workspaceId, options.repoPath, {
    spec: options.spec,
    focusedFile: options.focusedFile,
  })
  await revealPanel(options.workspaceId, panelId, { retry: true })
  return panelId
}
