// =============================================================================
// CanvasNode — the panel wrapper component for the infinite canvas.
// Ported from CanvasNode.swift (~680 lines of drag, resize, focus, activity
// border logic).
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PanelType, NodeActivityState } from '../../shared/types'
import { isMaximized as checkMaximized } from '../../shared/types'
import { useCanvasStore } from '../stores/canvasStore'
import { useAppStore } from '../stores/appStore'
import { useNodeDrag } from '../hooks/useNodeDrag'
import { useNodeResize, detectEdge, getCursorForEdge } from '../hooks/useNodeResize'
import CanvasNodeTitleBar from './CanvasNodeTitleBar'
import CanvasNodeTabBar from './CanvasNodeTabBar'

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

const TITLE_BAR_HEIGHT = 28
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
    case 'claudeWaitingForInput':
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

  const nodeRef = useRef<HTMLDivElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [isAnimatingLayout, setIsAnimatingLayout] = useState(false)
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Read node geometry from store
  const node = useCanvasStore((s) => s.nodes[nodeId])
  const focusNode = useCanvasStore((s) => s.focusNode)
  const removeNode = useCanvasStore((s) => s.removeNode)
  const toggleMaximize = useCanvasStore((s) => s.toggleMaximize)
  const isSelected = useCanvasStore((s) => s.selectedNodeIds.has(nodeId))

  // Hooks
  const { handleDragStart, wasDragged } = useNodeDrag(nodeId, zoomLevel)
  const { handleResizeStart, getCursor } = useNodeResize(nodeId, panelType, zoomLevel)

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
          useCanvasStore.getState().setNodeAnimationState(nodeId, 'idle')
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
        useCanvasStore.getState().finalizeRemoveNode(nodeId)
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
      useCanvasStore.getState().toggleNodeSelection(nodeId)
      return
    }
    // Select just this node (clears other selections) and focus
    useCanvasStore.getState().selectNodes([nodeId])
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
    useCanvasStore.getState().togglePin(nodeId)
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
    const canvasStore = useCanvasStore.getState()

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

  const handleDetach = useCallback(async () => {
    if (!node) return
    const wsId = useAppStore.getState().selectedWorkspaceId
    const panel = useAppStore.getState().workspaces
      .find(w => w.id === wsId)
      ?.panels[node.panelId]
    await window.electronAPI.detachPanel({
      panelId: node.panelId,
      panelType: panelType,
      title: panel?.title || title,
      width: Math.round(node.size.width),
      height: Math.round(node.size.height),
    })
    // Remove the node from the canvas after detaching
    removeNode(nodeId)
  }, [node, panelId, panelType, title, nodeId, removeNode])

  const handleSplitHorizontal = useCallback(() => {
    const wsId = useAppStore.getState().selectedWorkspaceId
    const panelId = crypto.randomUUID()
    useAppStore.getState().addPanel(wsId, { id: panelId, type: panelType, title: 'Split', isDirty: false })
    useCanvasStore.getState().splitNode(nodeId, 'horizontal', panelId)
  }, [nodeId, panelType])

  const handleSplitVertical = useCallback(() => {
    const wsId = useAppStore.getState().selectedWorkspaceId
    const panelId = crypto.randomUUID()
    useAppStore.getState().addPanel(wsId, { id: panelId, type: panelType, title: 'Split', isDirty: false })
    useCanvasStore.getState().splitNode(nodeId, 'vertical', panelId)
  }, [nodeId, panelType])

  const handleAddTab = useCallback(() => {
    const wsId = useAppStore.getState().selectedWorkspaceId
    const newPanelId = crypto.randomUUID()
    useAppStore.getState().addPanel(wsId, { id: newPanelId, type: 'editor', title: 'Untitled', isDirty: false })
    useCanvasStore.getState().stackPanel(nodeId, newPanelId)
  }, [nodeId])

  const handleSelectTab = useCallback((index: number) => {
    useCanvasStore.getState().setActiveStackPanel(nodeId, index)
  }, [nodeId])

  const handleCloseTab = useCallback((tabPanelId: string) => {
    useCanvasStore.getState().unstackPanel(nodeId, tabPanelId)
  }, [nodeId])

  // Stack state
  const hasStack = node?.stackedPanelIds && node.stackedPanelIds.length > 1
  const currentWorkspace = useAppStore((s) => s.workspaces.find(w => w.id === s.selectedWorkspaceId))

  // --- Computed styles -------------------------------------------------------

  const containerStyle = useMemo<React.CSSProperties>(() => {
    if (!node) return { display: 'none' }

    const isPulsing = activityState?.type === 'claudeWaitingForInput'
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
        onDetach={handleDetach}
      />

      {/* Tab bar — rendered when node has stacked panels */}
      {hasStack && (
        <CanvasNodeTabBar
          tabs={(node.stackedPanelIds || []).map(pid => {
            const p = currentWorkspace?.panels[pid]
            return { panelId: pid, title: p?.title || 'Panel', type: (p?.type || 'editor') as PanelType }
          })}
          activeIndex={node.activeStackIndex || 0}
          onSelectTab={handleSelectTab}
          onCloseTab={handleCloseTab}
        />
      )}

      {/* Content area */}
      <div
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
              useCanvasStore.getState().toggleNodeSelection(nodeId)
              return
            }
            useCanvasStore.getState().selectNodes([nodeId])
            focusNode(nodeId)
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
          <div
            style={{
              position: 'relative',
              width: '100%',
              height: '100%',
              display: 'flex',
              flexDirection: node.split.direction === 'horizontal' ? 'row' : 'column',
            }}
          >
            {/* First panel */}
            <div
              style={{
                [node.split.direction === 'horizontal' ? 'width' : 'height']: `${node.split.ratio * 100}%`,
                overflow: 'hidden',
                position: 'relative',
                zIndex: 0,
                flexShrink: 0,
              }}
            >
              {children}
            </div>

            {/* Divider */}
            <div
              style={{
                [node.split.direction === 'horizontal' ? 'width' : 'height']: 4,
                backgroundColor: 'rgba(255,255,255,0.1)',
                cursor: node.split.direction === 'horizontal' ? 'col-resize' : 'row-resize',
                flexShrink: 0,
              }}
              onMouseDown={(e) => {
                e.stopPropagation()
                const split = node.split!
                const startPos = split.direction === 'horizontal' ? e.clientX : e.clientY
                const startRatio = split.ratio
                const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
                const totalSize = split.direction === 'horizontal' ? rect.width : rect.height

                const handleMove = (ev: MouseEvent) => {
                  const currentPos = split.direction === 'horizontal' ? ev.clientX : ev.clientY
                  const delta = (currentPos - startPos) / totalSize
                  useCanvasStore.getState().setSplitRatio(nodeId, startRatio + delta)
                }
                const handleUp = () => {
                  window.removeEventListener('mousemove', handleMove)
                  window.removeEventListener('mouseup', handleUp)
                }
                window.addEventListener('mousemove', handleMove)
                window.addEventListener('mouseup', handleUp)
              }}
            />

            {/* Second panel */}
            <div style={{ flex: 1, overflow: 'hidden', position: 'relative', zIndex: 0 }}>
              {splitContent}
            </div>
          </div>
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
            width: 8,
            height: 8,
            borderRadius: 2,
            backgroundColor: 'rgba(255, 255, 255, 0.2)',
            border: '1.5px solid rgba(255, 255, 255, 0.4)',
            opacity: isHovered ? 1 : 0,
            transition: 'opacity 150ms ease',
            pointerEvents: 'none',
            ...(corner.includes('top') ? { top: -2 } : { bottom: -2 }),
            ...(corner.includes('left') ? { left: -2 } : { right: -2 }),
          }}
        />
      ))}
    </div>
  )
}

export default React.memo(CanvasNode)
