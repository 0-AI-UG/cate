import React from 'react'
import type { PanelProps } from './types'
import { useAppStore } from '../stores/appStore'
import AgentChangesView from './AgentChangesView'
import GitReviewPanel from './GitReviewPanel'
import { LoadingState } from '../ui/Spinner'

export { collapsedHunkGaps } from './GitReviewPanel'
export { ReviewNoteComposer, UnifiedLine } from './ReviewDiff'

export default function ReviewPanel(props: PanelProps) {
  const panel = useAppStore((s) => s.workspaces.find((w) => w.id === props.workspaceId)?.panels[props.panelId])
  if (!panel) return <LoadingState label="Loading review panel…" className="h-full p-4 text-xs" />
  return panel.reviewState?.agentChanges ? <AgentChangesView {...props} /> : <GitReviewPanel {...props} />
}
