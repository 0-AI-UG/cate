import React, { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { DockLayoutNode, DockSplitNode, DockTabStack as DockTabStackNode, PanelType } from '../../shared/types'
import { layoutMinimum } from './splitSizing'
import DockSplitContainer from './DockSplitContainer'

interface DockLayoutRendererProps {
  layout: DockLayoutNode
  renderTabs: (stack: DockTabStackNode, isRoot: boolean) => React.ReactNode
  getPanelType?: (panelId: string) => PanelType | undefined
}

function collectTabStacks(node: DockLayoutNode): DockTabStackNode[] {
  if (node.type === 'tabs') return [node]
  return node.children.flatMap(collectTabStacks)
}

function DockTabSlot({ host }: { host: HTMLDivElement }) {
  const slotRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const slot = slotRef.current
    if (!slot) return
    slot.appendChild(host)
    return () => {
      if (host.parentNode === slot) slot.removeChild(host)
    }
  }, [host])
  return <div ref={slotRef} className="h-full w-full min-h-0 min-w-0" />
}

/** Shared recursive renderer for window docks and canvas-node mini-docks. */
export default function DockLayoutRenderer({ layout, renderTabs, getPanelType }: DockLayoutRendererProps) {
  const minimum = layoutMinimum(layout, getPanelType)
  const hostsRef = useRef(new Map<string, HTMLDivElement>())
  const stacks = collectTabStacks(layout)
  const stackIds = new Set(stacks.map((stack) => stack.id))
  for (const id of hostsRef.current.keys()) {
    if (!stackIds.has(id)) hostsRef.current.delete(id)
  }
  for (const stack of stacks) {
    if (hostsRef.current.has(stack.id)) continue
    const host = document.createElement('div')
    host.className = 'h-full w-full min-h-0 min-w-0'
    hostsRef.current.set(stack.id, host)
  }
  const renderNode = (node: DockLayoutNode): React.ReactNode => {
    if (node.type === 'tabs') return <DockTabSlot host={hostsRef.current.get(node.id)!} />
    return (
      <DockSplitContainer
        key={node.id}
        node={node}
        renderNode={renderNode}
        getPanelType={getPanelType}
      />
    )
  }

  // Keep the root component and keyed pane stable for the common first split.
  // Portals above the mutable layout tree also preserve tab-stack instances
  // when nested splits are introduced or collapsed around them.
  const root: DockSplitNode = layout.type === 'split' ? layout : {
    type: 'split',
    id: '__dock_root__',
    direction: 'horizontal',
    children: [layout],
    ratios: [1],
  }
  return <>
    <div data-dock-viewport className="h-full w-full min-h-0 min-w-0 overflow-auto">
      <div style={{ width: '100%', height: '100%', minWidth: minimum.width, minHeight: minimum.height }}>
        <DockSplitContainer
          node={root}
          renderNode={renderNode}
          getPanelType={getPanelType}
        />
      </div>
    </div>
    {stacks.map((stack) => createPortal(
      renderTabs(stack, layout.type === 'tabs' && stack.id === layout.id),
      hostsRef.current.get(stack.id)!,
      stack.id,
    ))}
  </>
}
