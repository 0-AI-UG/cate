// =============================================================================
// NodeSwitcher — Modal panel switcher overlay.
// Ported from NodeSwitcherView.swift
// =============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Terminal, Globe, FileText } from '@phosphor-icons/react'
import { useUIStore } from '../stores/uiStore'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useAppStore } from '../stores/appStore'
import type { PanelType, CanvasNodeId } from '../../shared/types'

// -----------------------------------------------------------------------------
// Icon components (inline SVG for panel type icons)
// -----------------------------------------------------------------------------

function PanelIcon({ type }: { type: PanelType }) {
  const size = 20
  switch (type) {
    case 'terminal':
      return <Terminal size={size} color="#34C759" />
    case 'browser':
      return <Globe size={size} color="#007AFF" />
    case 'editor':
      return <FileText size={size} color="#FF9500" />
  }
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export const NodeSwitcher: React.FC = () => {
  const showNodeSwitcher = useUIStore((s) => s.showNodeSwitcher)
  const setShowNodeSwitcher = useUIStore((s) => s.setShowNodeSwitcher)
  const canvasApi = useCanvasStoreApi()
  const focusNode = useCanvasStoreContext((s) => s.focusNode)
  const setViewportOffset = useCanvasStoreContext((s) => s.setViewportOffset)
  const zoomLevel = useCanvasStoreContext((s) => s.zoomLevel)
  const nodes = useCanvasStoreContext((s) => s.nodes)
  const workspace = useAppStore((s) => s.selectedWorkspace())

  // Build items list: sorted by creation order, with panel info
  // Keyed on workspace id and node count to avoid recomputing on unrelated node property changes
  const nodeIds = useMemo(() => Object.keys(nodes).sort(), [nodes])
  const items = useMemo(() => {
    if (!workspace) return []
    const sorted = canvasApi.getState().sortedNodesByCreationOrder()
    return sorted.map((node) => {
      const panel = workspace.panels[node.panelId]
      return {
        nodeId: node.id,
        title: panel?.title ?? 'Untitled',
        type: (panel?.type ?? 'terminal') as PanelType,
      }
    })
  }, [workspace, nodeIds])

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
        className="w-80 max-h-[400px] bg-[#262523] rounded-xl border border-white/[0.12] shadow-2xl overflow-hidden"
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
