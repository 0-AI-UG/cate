import React from 'react'
import type { DockLayoutNode, DockTabStack as DockTabStackNode, PanelType } from '../../shared/types'
import { useDockStoreContext } from '../stores/DockStoreContext'
import { findTabStack } from '../stores/dockTreeUtils'
import { layoutMinimum } from './splitSizing'
import DockSplitContainer from './DockSplitContainer'

interface DockLayoutRendererProps {
  layout: DockLayoutNode
  renderTabs: (stack: DockTabStackNode, isRoot: boolean) => React.ReactNode
  getPanelType?: (panelId: string) => PanelType | undefined
}

/** Shared recursive renderer for window docks and canvas-node mini-docks. */
export default function DockLayoutRenderer({ layout, renderTabs, getPanelType }: DockLayoutRendererProps) {
  const maximizedId = useDockStoreContext((s) => s.maximizedStackId)
  const maximized = maximizedId ? findTabStack(layout, maximizedId) : null
  const minimum = layoutMinimum(maximized ?? layout, getPanelType)
  const renderNode = (node: DockLayoutNode, isRoot: boolean): React.ReactNode => {
    if (node.type === 'tabs') return renderTabs(node, isRoot)
    return (
      <DockSplitContainer
        key={node.id}
        node={node}
        renderNode={(child) => renderNode(child, false)}
        getPanelType={getPanelType}
      />
    )
  }
  return <div data-dock-viewport className="h-full w-full min-h-0 min-w-0 overflow-auto">
    <div style={{ width: '100%', height: '100%', minWidth: minimum.width, minHeight: minimum.height }}>
      {renderNode(layout, true)}
    </div>
  </div>
}
