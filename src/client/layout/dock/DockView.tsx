// The view of one dock of the document: a window's dock, or a canvas node's
// mini dock (same tree shape). It draws the tree under this client's
// presentations, commits divider moves as `setSplitRatio`, and opens files
// dropped on it as tabs.

import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  dockStacks,
  isCanvasDock,
  type DockNode,
  type DockRef,
  type DockStack,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import type { PanelPlacementOptions } from '@panels/framework/contract'
import { documentStoreFor } from '@client/document'
import { useDocument } from '@client/document/ui'
import { PanelHost } from '@client/host'
import { registerDropZone } from '../drag/registry'
import { useDockFileDrop } from '../drag/fileDrop'
import { DockLayout } from './DockLayout'
import { DockTabStack } from './DockTabStack'
import { presentedDock } from './presentation'
import { usePresentations } from './usePresentations'

/** Same tabs, shape, ids and ratios. */
export function sameDockTree(a: DockNode | null, b: DockNode | null): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind || a.id !== b.id) return false
  if (a.kind === 'stack' && b.kind === 'stack') return a.panels.length === b.panels.length && a.panels.every((id, i) => id === b.panels[i])
  if (a.kind === 'split' && b.kind === 'split') {
    return a.direction === b.direction
      && a.children.length === b.children.length
      && a.ratios.every((r, i) => r === b.ratios[i])
      && a.children.every((child, i) => sameDockTree(child, b.children[i]))
  }
  return false
}

export interface DockViewProps {
  workspaceId: string
  dock: DockRef
  /** Renders a panel; PanelHost by default. */
  renderPanel?: (panelId: string) => React.ReactNode
  /** Shown while the dock is empty (an empty main window). */
  emptyContent?: React.ReactNode
  /** Node mini docks: the slim tab bar. */
  compact?: boolean
  trailingControls?: React.ReactNode
  newTabControl?: React.ReactNode
  onTabBarMouseDown?: (e: React.MouseEvent, panelId?: string) => void
  dropDisabled?: boolean
  onPresentPanel?: (panelId: string) => void
  className?: string
  /** Space the top-left stack's tab bar leaves for window chrome. */
  leadingInset?: number
}

export function dockKey(dock: DockRef): string {
  return isCanvasDock(dock) ? `node:${dock.canvasId}:${dock.nodeId}` : `window:${dock.windowId}`
}

export function DockView({
  workspaceId, dock: dockProp, renderPanel, emptyContent, compact, trailingControls, newTabControl,
  onTabBarMouseDown, dropDisabled, onPresentPanel, className, leadingInset,
}: DockViewProps) {
  // Callers may pass a fresh object each render; the dock's identity is its key.
  const key = dockKey(dockProp)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dock = useMemo(() => dockProp, [key])
  const presentations = usePresentations(workspaceId)
  const selector = useMemo(() => (doc: WorkspaceDocument) => presentedDock(doc, dock, presentations), [dock, presentations])
  const tree = useDocument(workspaceId, selector, sameDockTree)
  const onCanvas = isCanvasDock(dock)
  const rootRef = useRef<HTMLDivElement>(null)

  const typeOf = useCallback((panelId: string) => documentStoreFor(workspaceId)?.getSnapshot().panels[panelId]?.type, [workspaceId])
  const onRatios = useCallback((splitId: string, ratios: number[]) => {
    documentStoreFor(workspaceId)?.propose({ kind: 'setSplitRatio', splitId, ratios })
  }, [workspaceId])
  const panelRenderer = useCallback(
    (panelId: string) => renderPanel ? renderPanel(panelId) : <PanelHost workspaceId={workspaceId} panelId={panelId} onCanvas={onCanvas} />,
    [renderPanel, workspaceId, onCanvas],
  )

  // The whole dock is a target too: into its first stack, or a new stack of
  // an empty window.
  useEffect(() => {
    if (onCanvas) return
    return registerDropZone({
      id: `dock-${workspaceId}-${'windowId' in dock ? dock.windowId : ''}`,
      workspaceId,
      dock,
      getRect: () => rootRef.current?.getBoundingClientRect() ?? null,
      getElement: () => rootRef.current,
    })
  }, [workspaceId, dock, onCanvas])

  const firstStack = tree ? dockStacks(tree)[0] : undefined
  const filePlacement = useCallback((): PanelPlacementOptions => (
    firstStack ? { at: { to: 'stack', dock, stackId: firstStack.id } } : {}
  ), [dock, firstStack])
  const fileDrop = useDockFileDrop(workspaceId, filePlacement)

  const renderStack = useCallback((stack: DockStack) => tree && (
    <DockTabStack
      key={stack.id}
      workspaceId={workspaceId}
      dock={dock}
      stack={stack}
      layout={tree}
      renderPanel={panelRenderer}
      trailingControls={trailingControls}
      newTabControl={newTabControl}
      onTabBarMouseDown={onTabBarMouseDown}
      compact={compact}
      dropDisabled={dropDisabled}
      onPresentPanel={onPresentPanel}
      leadingInset={stack.id === firstStack?.id ? leadingInset : undefined}
    />
  ), [tree, workspaceId, dock, panelRenderer, trailingControls, newTabControl, onTabBarMouseDown, compact, dropDisabled, onPresentPanel, firstStack, leadingInset])

  if (onCanvas) {
    return tree ? <DockLayout layout={tree} renderStack={renderStack} typeOf={typeOf} onRatios={onRatios} /> : null
  }
  return (
    <div
      ref={rootRef}
      data-dock-window={'windowId' in dock ? dock.windowId : undefined}
      data-filedrop="dock"
      data-filedrop-id={'windowId' in dock ? dock.windowId : ''}
      className={`flex flex-col overflow-hidden relative bg-canvas-bg ${className ?? ''}`}
      style={{ width: '100%', height: '100%' }}
      onDragOver={fileDrop.onDragOver}
      onDrop={fileDrop.onDrop}
    >
      {tree
        ? <DockLayout layout={tree} renderStack={renderStack} typeOf={typeOf} onRatios={onRatios} />
        : emptyContent ?? <div className="w-full h-full" />}
    </div>
  )
}
