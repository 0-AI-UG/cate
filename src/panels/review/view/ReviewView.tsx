import React, { useCallback } from 'react'
import { LoadingState } from '@kernel/ui'
import type { PanelViewProps } from '@client/host'
import type { ReviewOp, ReviewSnapshot } from '../contract'
import AgentChangesView from './AgentChangesView'
import GitReviewView from './GitReviewView'

export default function ReviewView({ workspaceId, panelId, snapshot, send }: PanelViewProps<ReviewSnapshot, ReviewOp>) {
  const sendOp = useCallback((op: ReviewOp) => send(op), [send])
  if (!snapshot) return <LoadingState label="Loading review panel…" className="h-full p-4 text-xs" />
  return snapshot.review.agentChanges
    ? <AgentChangesView workspaceId={workspaceId} panelId={panelId} snapshot={snapshot} send={sendOp} />
    : <GitReviewView workspaceId={workspaceId} panelId={panelId} snapshot={snapshot} send={sendOp} />
}
