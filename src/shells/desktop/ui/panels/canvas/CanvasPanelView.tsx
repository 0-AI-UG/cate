// The canvas panel's view: the canvas it names.

import React from 'react'
import type { PanelViewProps } from '../../client/host/views'
import { CanvasView } from '../../client/layout/canvas'

export default function CanvasPanelView({ workspaceId, panelId, record }: PanelViewProps): React.ReactElement | null {
  const canvasId = record.canvasId
  if (!canvasId) return null
  return <CanvasView workspaceId={workspaceId} canvasId={canvasId} canvasPanelId={panelId} />
}
