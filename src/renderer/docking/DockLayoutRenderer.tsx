import React from 'react'
import type { DockLayoutNode, DockTabStack as DockTabStackNode } from '../../shared/types'
import DockSplitContainer from './DockSplitContainer'

interface DockLayoutRendererProps {
  layout: DockLayoutNode
  renderTabs: (stack: DockTabStackNode, isRoot: boolean) => React.ReactNode
}

/** Shared recursive renderer for window docks and canvas-node mini-docks. */
export default function DockLayoutRenderer({ layout, renderTabs }: DockLayoutRendererProps) {
  const renderNode = (node: DockLayoutNode, isRoot: boolean): React.ReactNode => {
    if (node.type === 'tabs') return renderTabs(node, isRoot)
    return (
      <DockSplitContainer
        key={node.id}
        node={node}
        renderNode={(child) => renderNode(child, false)}
      />
    )
  }
  return <>{renderNode(layout, true)}</>
}
