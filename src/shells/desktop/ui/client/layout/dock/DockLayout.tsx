// Draws a dock tree: splits recursively, each stack through `renderStack`.
// Stacks render into stable detached hosts portalled into their slots, so a
// stack keeps its instance (and its panels' state) when splits appear or
// collapse around it. The same renderer draws window docks and node docks.

import React, { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { dockStacks, type DockNode, type DockSplit, type DockStack } from '@workspace/document/contract'
import { DockSplitContainer } from './DockSplitContainer'
import { layoutMinimum, type PanelTypeOf } from './sizing'

interface DockLayoutProps {
  layout: DockNode
  renderStack: (stack: DockStack, isRoot: boolean) => React.ReactNode
  typeOf?: PanelTypeOf
  onRatios?: (splitId: string, ratios: number[]) => void
}

function DockStackSlot({ host }: { host: HTMLDivElement }) {
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

export function DockLayout({ layout, renderStack, typeOf, onRatios }: DockLayoutProps) {
  const minimum = layoutMinimum(layout, typeOf)
  const hostsRef = useRef(new Map<string, HTMLDivElement>())
  const stacks = dockStacks(layout)
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
  const renderNode = (node: DockNode): React.ReactNode => {
    if (node.kind === 'stack') return <DockStackSlot host={hostsRef.current.get(node.id)!} />
    return <DockSplitContainer key={node.id} node={node} renderNode={renderNode} typeOf={typeOf} onRatios={onRatios} />
  }

  // A stable root keeps the first split from remounting the lone stack.
  const root: DockSplit = layout.kind === 'split' ? layout : {
    kind: 'split',
    id: '__dock_root__',
    direction: 'horizontal',
    children: [layout],
    ratios: [1],
  }
  return <>
    <div data-dock-viewport className="h-full w-full min-h-0 min-w-0 overflow-auto">
      <div style={{ width: '100%', height: '100%', minWidth: minimum.width, minHeight: minimum.height }}>
        <DockSplitContainer node={root} renderNode={renderNode} typeOf={typeOf} onRatios={onRatios} />
      </div>
    </div>
    {stacks.map((stack) => createPortal(
      renderStack(stack, layout.kind === 'stack' && stack.id === layout.id),
      hostsRef.current.get(stack.id)!,
      stack.id,
    ))}
  </>
}
