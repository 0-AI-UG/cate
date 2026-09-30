// Components and hooks the canvas uses but does not own. The node mini dock
// is client/layout/dock's DockView over the node's dock, surfaces and panels
// come from client/host; status tracking installs node activity. Tests swap
// them. Install once at startup: a hook slot must not change while mounted.

import React from 'react'
import type { DockNode, NodeId } from '@workspace/document/contract'
import { PanelHost, syncPanelSurfaces } from '@client/host'
import { DockView } from '@client/layout/dock'

export interface NodeDockProps {
  workspaceId: string
  canvasId: string
  nodeId: NodeId
  /** The node's mini dock tree. */
  dock: DockNode
  /** Mouse-down on the root stack's tab bar: `panelId` when on a tab, absent
   *  on the empty bar. The canvas starts a node drag or a tab detach. */
  onTabBarMouseDown?: (event: React.MouseEvent, panelId?: string) => void
  /** Node controls (lock, close) at the end of the root stack's tab bar. */
  trailingControls?: React.ReactNode
  /** The node itself is being dragged: its stacks take no drops. */
  dropDisabled?: boolean
}

/** What a node's outline shows: a command finished, or an agent waits for
 *  input (pulses). */
export type NodeActivity = 'finished' | 'waiting'

export interface CanvasSlots {
  NodeDock: React.ComponentType<NodeDockProps>
  /** A hook: the activity of a node's active panel. Installed by the module
   *  that tracks terminal and agent status. */
  useNodeActivity: (workspaceId: string, panelId: string | null) => NodeActivity | undefined
  /** Realigns native surfaces (webviews in a fixed host outside the
   *  transformed canvas) in the same task as a viewport change, so they never
   *  trail their nodes by a frame. Installed by client/host. */
  syncSurfaces: () => void
  /** Renders one panel; the list fallback of a client without `canvas` uses
   *  it. Installed by client/host. */
  PanelHost?: React.ComponentType<{ workspaceId: string; panelId: string }>
}

function ClientNodeDock({ workspaceId, canvasId, nodeId, onTabBarMouseDown, trailingControls, dropDisabled }: NodeDockProps): React.ReactElement {
  return (
    <DockView
      workspaceId={workspaceId}
      dock={{ canvasId, nodeId }}
      compact
      onTabBarMouseDown={onTabBarMouseDown}
      trailingControls={trailingControls}
      dropDisabled={dropDisabled}
    />
  )
}

const noActivity = (): NodeActivity | undefined => undefined

let slots: CanvasSlots = { NodeDock: ClientNodeDock, useNodeActivity: noActivity, syncSurfaces: syncPanelSurfaces, PanelHost }

export function installCanvasSlots(next: Partial<CanvasSlots>): void {
  slots = { ...slots, ...next }
}

export function canvasSlots(): CanvasSlots {
  return slots
}
