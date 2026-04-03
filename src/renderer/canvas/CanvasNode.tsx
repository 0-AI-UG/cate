// =============================================================================
// CanvasNode — the panel wrapper component for the infinite canvas.
// Ported from CanvasNode.swift (~680 lines of drag, resize, focus, activity
// border logic).
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PanelType, NodeActivityState } from '../../shared/types'
import { isMaximized as checkMaximized } from '../../shared/types'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useAppStore, useSelectedWorkspace } from '../stores/appStore'
import { useNodeDrag } from '../hooks/useNodeDrag'
import { useNodeResize, detectEdge, getCursorForEdge } from '../hooks/useNodeResize'
import CanvasNodeTitleBar from './CanvasNodeTitleBar'
import CanvasNodeTabBar from './CanvasNodeTabBar'
import SplitView from './SplitView'

// -----------------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------------

interface CanvasNodeProps {
  nodeId: string
  panelId: string
  panelType: PanelType
  title: string
  isFocused: boolean
  activityState?: NodeActivityState
  zoomLevel: number
  children: React.ReactNode
  splitContent?: React.ReactNode
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const TITLE_BAR_HEIGHT = 24
const CORNER_RADIUS = 8

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

/** Border color depending on focus state. */
function borderColor(focused: boolean): string {
  return focused
    ? 'rgba(74, 158, 255, 0.5)'
    : 'rgba(255, 255, 255, 0.1)'
}

/** Box shadow depending on focus state, scaled to appear constant size on screen. */
function boxShadow(focused: boolean, zoom: number): string {
  // Scale shadow to appear constant size on screen regardless of zoom
  const scale = 1 / Math.max(zoom, 0.3)
  return focused
    ? `0 ${-2 * scale}px ${8 * scale}px rgba(74, 158, 255, 0.3)`
    : `0 ${-1 * scale}px ${4 * scale}px rgba(0, 0, 0, 0.3)`
}

/** Activity outline style. Returns empty string when no activity decoration needed. */
function activityOutline(activity: NodeActivityState | undefined): string {
  if (!activity) return 'none'
  switch (activity.type) {
    case 'commandFinished':
      return '2px solid rgba(77, 217, 100, 0.7)'
    case 'agentWaitingForInput':
      return '2px solid rgba(255, 149, 0, 0.8)'
    default:
      return 'none'
  }
}

// -----------------------------------------------------------------------------
// Pulse animation keyframes (injected once via a <style> tag)
// -----------------------------------------------------------------------------

const PULSE_KEYFRAMES = `
@keyframes pulseActivity {
  0% { outline-color: rgba(255, 149, 0, 0.4); }
  100% { outline-color: rgba(255, 149, 0, 1.0); }
}
`

let keyframesInjected = false
function ensureKeyframes() {
  if (keyframesInjected) return
  if (typeof document === 'undefined') return
  const style = document.createElement('style')
  style.textContent = PULSE_KEYFRAMES
  document.head.appendChild(style)
  keyframesInjected = true
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

const CanvasNode: React.FC<CanvasNodeProps> = ({
  nodeId,
  panelId,
  panelType,
  title,
  isFocused,
  activityState,
  zoomLevel,
  children,
  splitContent,
}) => {
  ensureKeyframes()

  const canvasApi = useCanvasStoreApi()
  const nodeRef = useRef<HTMLDivElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [isAnimatingLayout, setIsAnimatingLayout] = useState(false)
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Read node geometry from store
  const node = useCanvasStoreContext((s) => s.nodes[nodeId])
  const focusNode = useCanvasStoreContext((s) => s.focusNode)
  const removeNode = useCanvasStoreContext((s) => s.removeNode)
  const toggleMaximize = useCanvasStoreContext((s) => s.toggleMaximize)
  const isSelected = useCanvasStoreContext((s) => s.selectedNodeIds.has(nodeId))

  // Hooks
  const { handleDragStart, wasDragged } = useNodeDrag(nodeId, zoomLevel, canvasApi)
  const { handleResizeStart, getCursor } = useNodeResize(nodeId, panelType, zoomLevel, canvasApi)

  // Maximize state
  const maximized = node ? checkMaximized(node) : false

  // --- Animation lifecycle ---------------------------------------------------

  useEffect(() => {
    if (!node) return

    if (node.animationState === 'entering') {
      // Double-rAF: first frame renders the initial "before" state (scale(0.85) opacity(0)),
      // second frame triggers the CSS transition to scale(1) opacity(1).
      let innerRaf = 0
      const outerRaf = requestAnimationFrame(() => {
        innerRaf = requestAnimationFrame(() => {
          canvasApi.getState().setNodeAnimationState(nodeId, 'idle')
        })
      })
      return () => {
        cancelAnimationFrame(outerRaf)
        cancelAnimationFrame(innerRaf)
      }
    }

    if (node.animationState === 'exiting') {
      // Wait for the exit CSS transition to complete, then remove from store.
      const timer = setTimeout(() => {
        canvasApi.getState().finalizeRemoveNode(nodeId)
      }, 200)
      animationTimerRef.current = timer
      return () => clearTimeout(timer)
    }
  }, [node?.animationState, nodeId])

  // --- Event handlers --------------------------------------------------------

  /** Focus the node on any click if not already focused. Shift-click toggles selection.
   *  Skip focus if the click followed a drag (user was moving the node, not activating it). */
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (wasDragged.current) return
    if (e.shiftKey) {
      canvasApi.getState().toggleNodeSelection(nodeId)
      return
    }
    // Select just this node (clears other selections) and focus
    canvasApi.getState().selectNodes([nodeId])
    if (!isFocused) {
      focusNode(nodeId)
    }
  }, [isFocused, focusNode, nodeId, wasDragged])

  /** On mouse down: detect resize edge or prepare for drag. */
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Right-click: stop propagation so the canvas doesn't show its
      // background context menu alongside the node's own context menu.
      if (e.button === 2) {
        e.stopPropagation()
        return
      }
      // Only handle primary button
      if (e.button !== 0) return

      if (!nodeRef.current || !node) return

      const rect = nodeRef.current.getBoundingClientRect()
      const localX = e.clientX - rect.left
      const localY = e.clientY - rect.top

      // Check for resize edge
      const edge = detectEdge(localX, localY, rect.width, rect.height, zoomLevel)
      if (edge) {
        handleResizeStart(e, edge)
        return
      }
      // Drag is handled by the title bar's onDragStart — body clicks just focus
    },
    [nodeId, node, zoomLevel, handleResizeStart],
  )

  /** Update cursor when hovering near edges. */
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!nodeRef.current) return
      const rect = nodeRef.current.getBoundingClientRect()
      const localX = e.clientX - rect.left
      const localY = e.clientY - rect.top
      const edge = detectEdge(localX, localY, rect.width, rect.height, zoomLevel)
      const cursor = getCursorForEdge(edge)
      if (nodeRef.current.style.cursor !== cursor) {
        nodeRef.current.style.cursor = cursor
      }
    },
    [zoomLevel],
  )

  const handleClose = useCallback(() => {
    removeNode(nodeId)
  }, [removeNode, nodeId])

  const handleToggleMaximize = useCallback(() => {
    setIsAnimatingLayout(true)
    const viewportSize = {
      width: window.innerWidth,
      height: window.innerHeight,
    }
    toggleMaximize(nodeId, viewportSize)
    // Turn off layout animation after transition completes
    setTimeout(() => setIsAnimatingLayout(false), 300)
  }, [toggleMaximize, nodeId])

  const handleTogglePin = useCallback(() => {
    canvasApi.getState().togglePin(nodeId)
  }, [nodeId])

  /** Inline rename via prompt. */
  const handleRename = useCallback(() => {
    const name = window.prompt('Rename panel:', title)
    if (name && name.trim()) {
      const wsId = useAppStore.getState().selectedWorkspaceId
      useAppStore.getState().updatePanelTitle(wsId, panelId, name.trim())
    }
  }, [title, panelId])

  /** Duplicate: create a new panel of the same type, offset slightly. */
  const handleDuplicate = useCallback(() => {
    const wsId = useAppStore.getState().selectedWorkspaceId
    const appStore = useAppStore.getState()
    const canvasStore = canvasApi.getState()

    // Place the duplicate 40px to the right and below the current node
    const currentNode = canvasStore.nodes[nodeId]
    const offset = currentNode
      ? { x: currentNode.origin.x + 40, y: currentNode.origin.y + 40 }
      : undefined

    switch (panelType) {
      case 'terminal':
        appStore.createTerminal(wsId, undefined, offset)
        break
      case 'browser':
        appStore.createBrowser(wsId, undefined, offset)
        break
      case 'editor':
        appStore.createEditor(wsId, undefined, offset)
        break
    }
  }, [nodeId, panelType])

  const handleSplitHorizontal = useCallback(() => {
    const wsId = useAppStore.getState().selectedWorkspaceId
    const panelId = crypto.randomUUID()
    useAppStore.getState().addPanel(wsId, { id: panelId, type: panelType, title: 'Split', isDirty: false })
    canvasApi.getState().splitNode(nodeId, 'horizontal', panelId)
  }, [nodeId, panelType])

  const handleSplitVertical = useCallback(() => {
    const wsId = useAppStore.getState().selectedWorkspaceId
    const panelId = crypto.randomUUID()
    useAppStore.getState().addPanel(wsId, { id: panelId, type: panelType, title: 'Split', isDirty: false })
    canvasApi.getState().splitNode(nodeId, 'vertical', panelId)
  }, [nodeId, panelType])

  const handleAddTab = useCallback(() => {
    const wsId = useAppStore.getState().selectedWorkspaceId
    const newPanelId = crypto.randomUUID()
    useAppStore.getState().addPanel(wsId, { id: newPanelId, type: 'editor', title: 'Untitled', isDirty: false })
    canvasApi.getState().stackPanel(nodeId, newPanelId)
  }, [nodeId])

  const handleSelectTab = useCallback((index: number) => {
    canvasApi.getState().setActiveStackPanel(nodeId, index)
  }, [nodeId])

  const handleCloseTab = useCallback((tabPanelId: string) => {
    canvasApi.getState().unstackPanel(nodeId, tabPanelId)
  }, [nodeId])

  // Stack state
  const hasStack = node?.stackedPanelIds && node.stackedPanelIds.length > 1
  const currentWorkspace = useSelectedWorkspace()

  // Memoize tabs array to avoid re-creating on every render
  const tabs = useMemo(() => {
    if (!hasStack || !node?.stackedPanelIds) return []
    return node.stackedPanelIds.map(pid => {
      const p = currentWorkspace?.panels[pid]
      return { panelId: pid, title: p?.title || 'Panel', type: (p?.type || 'editor') as PanelType }
    })
  }, [hasStack, node?.stackedPanelIds, currentWorkspace?.panels])

  // --- Computed styles -------------------------------------------------------

  const containerStyle = useMemo<React.CSSProperties>(() => {
    if (!node) return { display: 'none' }

    const isPulsing = activityState?.type === 'agentWaitingForInput'
    const isEntering = node.animationState === 'entering'
    const isExiting = node.animationState === 'exiting'

    const baseTransition = 'border-color 150ms ease, box-shadow 200ms ease, outline-color 200ms ease, transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 150ms ease-out'
    const layoutTransition = isAnimatingLayout
      ? ', left 250ms cubic-bezier(0.16, 1, 0.3, 1), top 250ms cubic-bezier(0.16, 1, 0.3, 1), width 250ms cubic-bezier(0.16, 1, 0.3, 1), height 250ms cubic-bezier(0.16, 1, 0.3, 1)'
      : ''

    return {
      position: 'absolute',
      left: node.origin.x,
      top: node.origin.y,
      width: node.size.width,
      height: node.size.height,
      zIndex: node.zOrder,
      borderRadius: CORNER_RADIUS,
      overflow: 'hidden',
      border: `1.5px solid ${isSelected ? 'rgba(74, 158, 255, 0.8)' : borderColor(isFocused)}`,
      boxShadow: boxShadow(isFocused, zoomLevel),
      outline: activityOutline(activityState),
      outlineOffset: -1,
      animation: isPulsing
        ? 'pulseActivity 1s ease-in-out infinite alternate'
        : undefined,
      backgroundColor: '#1E1E24',
      transition: baseTransition + layoutTransition,
      transform: isEntering ? 'scale(0.85)' : isExiting ? 'scale(0.9)' : 'scale(1)',
      opacity: isEntering ? 0 : isExiting ? 0 : 1,
      pointerEvents: isExiting ? 'none' : undefined,
      // Prevent text selection during drag
      userSelect: 'none',
    }
  }, [node, isFocused, isSelected, activityState, zoomLevel, isAnimatingLayout])

  if (!node) return null

  return (
    <div
      ref={nodeRef}
      data-node-id={nodeId}
      style={containerStyle}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Title bar */}
      <CanvasNodeTitleBar
        nodeId={nodeId}
        panelType={panelType}
        title={title}
        isFocused={isFocused}
        isMaximized={maximized}
        isPinned={node?.isPinned ?? false}
        onClose={handleClose}
        onToggleMaximize={handleToggleMaximize}
        onTogglePin={handleTogglePin}
        onDragStart={handleDragStart}
        onRename={handleRename}
        onDuplicate={handleDuplicate}
        onSplitHorizontal={!node?.split ? handleSplitHorizontal : undefined}
        onSplitVertical={!node?.split ? handleSplitVertical : undefined}
        onAddTab={handleAddTab}
      />

      {/* Tab bar — rendered when node has stacked panels */}
      {hasStack && (
        <CanvasNodeTabBar
          tabs={tabs}
          activeIndex={node.activeStackIndex || 0}
          onSelectTab={handleSelectTab}
          onCloseTab={handleCloseTab}
        />
      )}

      {/* Content area */}
      <div
        data-panel-content
        onDragLeave={(e) => {
          // Restore overlay pointer events when drag leaves the content area
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            const overlay = e.currentTarget.querySelector<HTMLElement>('[data-unfocused-overlay]')
            if (overlay && !isFocused) overlay.style.pointerEvents = 'auto'
          }
        }}
        onDrop={() => {
          // Restore overlay pointer events after a drop
          const el = nodeRef.current?.querySelector<HTMLElement>('[data-unfocused-overlay]')
          if (el && !isFocused) el.style.pointerEvents = 'auto'
        }}
        style={{
          position: 'relative',
          height: `calc(100% - ${TITLE_BAR_HEIGHT}px${hasStack ? ' - 24px' : ''})`,
          overflow: 'hidden',
        }}
      >
        {/* Dim overlay for unfocused nodes — intercepts pointer events so
             panel-specific cursors (text cursor, etc.) don't show until focused.
             Click-and-drag on this overlay moves the window without activating it. */}
        <div
          data-unfocused-overlay
          onMouseDown={(e) => {
            if (isFocused || e.button !== 0) return
            e.stopPropagation()
            handleDragStart(e)
          }}
          onClick={(e) => {
            if (isFocused) return
            e.stopPropagation()
            if (wasDragged.current) return
            if (e.shiftKey) {
              canvasApi.getState().toggleNodeSelection(nodeId)
              return
            }
            canvasApi.getState().selectNodes([nodeId])
            focusNode(nodeId)
          }}
          onDragEnter={(e) => {
            // When an external file drag enters the overlay, disable pointer
            // events so subsequent dragover/drop events reach the panel content
            // beneath (e.g. terminal drop zone). Restored on dragleave/drop on
            // the parent node wrapper.
            if (
              e.dataTransfer.types.includes('Files') ||
              e.dataTransfer.types.includes('application/cate-file')
            ) {
              ;(e.currentTarget as HTMLElement).style.pointerEvents = 'none'
            }
          }}
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.15)',
            pointerEvents: isFocused ? 'none' : 'auto',
            cursor: isFocused ? undefined : 'default',
            zIndex: 1,
            opacity: isFocused ? 0 : 1,
            transition: 'opacity 150ms ease',
          }}
        />

        {/* Panel content — split or single */}
        {node.split ? (
          <SplitView
            direction={node.split.direction}
            ratio={node.split.ratio}
            onRatioChange={(ratio) => canvasApi.getState().setSplitRatio(nodeId, ratio)}
            splitContent={splitContent}
          >
            {children}
          </SplitView>
        ) : (
          <div style={{ position: 'relative', zIndex: 0, width: '100%', height: '100%' }}>
            {children}
          </div>
        )}
      </div>

      {/* Resize handle indicators */}
      {['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((corner) => (
        <div
          key={corner}
          style={{
            position: 'absolute',
            width: 6,
            height: 6,
            borderRadius: 1.5,
            backgroundColor: 'rgba(255, 255, 255, 0.15)',
            border: '1px solid rgba(255, 255, 255, 0.25)',
            opacity: isHovered ? 1 : 0,
            transition: 'opacity 150ms ease',
            pointerEvents: 'none',
            ...(corner.includes('top') ? { top: -1 } : { bottom: -1 }),
            ...(corner.includes('left') ? { left: -1 } : { right: -1 }),
          }}
        />
      ))}
    </div>
  )
}

export default React.memo(CanvasNode)
