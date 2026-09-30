// The canvas panel's view: the canvas it names, or, on a client without the
// `canvas` feature, its panels as a list.

import React from 'react'
import { clientHas } from '@client/connections'
import type { PanelViewProps } from '@client/host'
import { CanvasPanelList, CanvasView } from '@client/layout/canvas'

export default function CanvasPanelView({ workspaceId, panelId, record }: PanelViewProps): React.ReactElement | null {
  const canvasId = record.canvasId
  if (!canvasId) return null
  if (!clientHas('canvas')) return <CanvasPanelList workspaceId={workspaceId} canvasId={canvasId} />
  return <CanvasView workspaceId={workspaceId} canvasId={canvasId} canvasPanelId={panelId} />
}
