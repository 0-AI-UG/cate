// =============================================================================
// NodeSwitcher — Modal panel switcher overlay.
// Ported from NodeSwitcherView.swift
// =============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useUIStore } from '../stores/uiStore'
import { useCanvasStore } from '../stores/canvasStore'
import { useAppStore } from '../stores/appStore'
import type { PanelType, CanvasNodeId } from '../../shared/types'

// -----------------------------------------------------------------------------
// Icon components (inline SVG for panel type icons)
// -----------------------------------------------------------------------------

function PanelIcon({ type }: { type: PanelType }) {
  const size = 20
  switch (type) {
    case 'terminal':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#34C759"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      )
    case 'browser':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#007AFF"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      )
    case 'editor':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#FF9500"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      )
  }
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export const NodeSwitcher: React.FC = () => {
  const showNodeSwitcher = useUIStore((s) => s.showNodeSwitcher)
  const setShowNodeSwitcher = useUIStore((s) => s.setShowNodeSwitcher)
  const nodes = useCanvasStore((s) => s.nodes)
  const focusNode = useCanvasStore((s) => s.focusNode)
  const setViewportOffset = useCanvasStore((s) => s.setViewportOffset)
  const zoomLevel = useCanvasStore((s) => s.zoomLevel)
  const sortedNodesByCreationOrder = useCanvasStore((s) => s.sortedNodesByCreationOrder)
  const workspace = useAppStore((s) => s.selectedWorkspace())

  // Build items list: sorted by creation order, with panel info
  const items = useMemo(() => {
    if (!workspace) return []
    const sorted = sortedNodesByCreationOrder()
    return sorted.map((node) => {
      const panel = workspace.panels[node.panelId]
      return {
        nodeId: node.id,
        title: panel?.title ?? 'Untitled',
        type: (panel?.type ?? 'terminal') as PanelType,
      }
    })
  }, [workspace, nodes, sortedNodesByCreationOrder])

  // Default selection: second item (next panel after current)
  const [selectedIndex, setSelectedIndex] = useState(items.length > 1 ? 1 : 0)

  // Reset selection when modal opens
  useEffect(() => {
    if (showNodeSwitcher) {
      setSelectedIndex(items.length > 1 ? 1 : 0)
    }
  }, [showNodeSwitcher, items.length])

  const close = useCallback(() => {
    setShowNodeSwitcher(false)
  }, [setShowNodeSwitcher])

  const selectItem = useCallback(
    (nodeId: CanvasNodeId) => {
      const node = nodes[nodeId]
      if (!node) return

      // Focus the node
      focusNode(nodeId)

      // Center viewport on node
      const containerWidth = window.innerWidth
      const containerHeight = window.innerHeight
      const newOffset = {
        x: containerWidth / 2 - (node.origin.x + node.size.width / 2) * zoomLevel,
        y: containerHeight / 2 - (node.origin.y + node.size.height / 2) * zoomLevel,
      }
      setViewportOffset(newOffset)

      close()
    },
    [nodes, focusNode, setViewportOffset, zoomLevel, close],
  )

  // Keyboard navigation
  useEffect(() => {
    if (!showNodeSwitcher) return

    function handleKey(e: KeyboardEvent) {
      switch (e.key) {
        case 'Tab':
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) =>
            items.length === 0 ? 0 : (prev + 1) % items.length,
          )
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) =>
            items.length === 0
              ? 0
              : (prev - 1 + items.length) % items.length,
          )
          break
        case 'Enter':
          e.preventDefault()
          if (items[selectedIndex]) {
            selectItem(items[selectedIndex].nodeId)
          }
          break
        case 'Escape':
          e.preventDefault()
          close()
          break
      }
    }

    document.addEventListener('keydown', handleKey, { capture: true })
    return () =>
      document.removeEventListener('keydown', handleKey, { capture: true })
  }, [showNodeSwitcher, items, selectedIndex, selectItem, close])

  if (!showNodeSwitcher) return null

  return (
    <div
      className="fixed inset-0 bg-black/20 flex items-start justify-center pt-[20vh] z-50"
      onClick={close}
    >
      <div
        className="w-80 max-h-[400px] bg-[#2A2A32] rounded-xl border border-white/[0.12] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {items.length === 0 ? (
          <div className="text-white/50 text-sm text-center py-5">
            No open panels
          </div>
        ) : (
          <div className="overflow-y-auto max-h-[400px]">
            {items.map((item, index) => (
              <div
                key={item.nodeId}
                className={`h-10 flex items-center px-3 gap-3 cursor-pointer transition-colors ${
                  index === selectedIndex
                    ? 'bg-white/[0.1] rounded-lg'
                    : 'hover:bg-white/[0.05]'
                }`}
                onClick={() => selectItem(item.nodeId)}
              >
                <PanelIcon type={item.type} />
                <span className="text-sm text-white/90 truncate flex-1">
                  {item.title}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
