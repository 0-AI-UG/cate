import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useUIStore } from '../stores/uiStore'
import { useCanvasStore } from '../stores/canvasStore'
import { useAppStore } from '../stores/appStore'
import type { PanelType } from '../../shared/types'

function panelColor(type: PanelType): string {
  switch (type) {
    case 'terminal': return '#34C759'
    case 'browser': return '#007AFF'
    case 'editor': return '#FF9500'
    case 'aiChat': return '#AF52DE'
    case 'git': return '#FF3B30'
  }
}

function PanelIcon({ type }: { type: PanelType }) {
  const color = panelColor(type)
  const size = 28
  switch (type) {
    case 'terminal':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      )
    case 'browser':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      )
    case 'editor':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      )
    case 'aiChat':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="10" rx="2" ry="2" />
          <circle cx="12" cy="5" r="2" />
          <line x1="12" y1="7" x2="12" y2="11" />
        </svg>
      )
    case 'git':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      )
  }
}

/** Capture a thumbnail of a canvas node's DOM element. */
function useNodeThumbnails(show: boolean, nodeIds: string[]) {
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!show) return
    const result: Record<string, string> = {}
    let pending = nodeIds.length

    for (const nodeId of nodeIds) {
      const el = document.querySelector(`[data-node-id="${nodeId}"]`) as HTMLElement | null
      if (!el) {
        pending--
        if (pending === 0) setThumbnails(result)
        continue
      }

      // Use a canvas element to capture a scaled-down snapshot
      try {
        const rect = el.getBoundingClientRect()
        const scale = 160 / Math.max(rect.width, rect.height, 1)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(rect.width * scale)
        canvas.height = Math.round(rect.height * scale)
        const ctx = canvas.getContext('2d')
        if (ctx) {
          // Draw a simplified representation
          ctx.fillStyle = '#1E1E24'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          ctx.fillStyle = '#28282E'
          ctx.fillRect(0, 0, canvas.width, Math.round(28 * scale))
          // Draw some content lines
          ctx.fillStyle = 'rgba(255,255,255,0.15)'
          for (let y = Math.round(36 * scale); y < canvas.height - 10; y += Math.round(14 * scale)) {
            const lineWidth = Math.round((40 + Math.random() * 80) * scale)
            ctx.fillRect(Math.round(8 * scale), y, Math.min(lineWidth, canvas.width - 16), Math.round(6 * scale))
          }
          result[nodeId] = canvas.toDataURL()
        }
      } catch { /* ignore */ }

      pending--
      if (pending === 0) setThumbnails(result)
    }

    if (nodeIds.length === 0) setThumbnails({})
  }, [show, nodeIds.join(',')])

  return thumbnails
}

export function PanelSwitcher() {
  const show = useUIStore((s) => s.showPanelSwitcher)
  const nodes = useCanvasStore((s) => s.nodes)
  const focusedNodeId = useCanvasStore((s) => s.focusedNodeId)
  const workspace = useAppStore((s) => s.workspaces.find(w => w.id === s.selectedWorkspaceId))

  const nodeList = Object.values(nodes).sort((a, b) => a.creationIndex - b.creationIndex)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedRef = useRef<HTMLDivElement>(null)

  const thumbnails = useNodeThumbnails(show, nodeList.map(n => n.id))

  // Reset selection when opened — select currently focused node
  useEffect(() => {
    if (show) {
      const focusedIdx = nodeList.findIndex(n => n.id === focusedNodeId)
      setSelectedIndex(focusedIdx >= 0 ? focusedIdx : 0)
    }
  }, [show])

  // Scroll selected card into view
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedIndex])

  const close = useCallback(() => {
    useUIStore.getState().setShowPanelSwitcher(false)
  }, [])

  const selectItem = useCallback((index: number) => {
    const node = nodeList[index]
    if (!node) return
    useCanvasStore.getState().focusAndCenter(node.id)
    close()
  }, [nodeList, close])

  useEffect(() => {
    if (!show) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIndex((prev) => (prev + 1) % nodeList.length)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIndex((prev) => (prev - 1 + nodeList.length) % nodeList.length)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        close()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        selectItem(selectedIndex)
      }
    }

    document.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  }, [show, selectedIndex, nodeList, close, selectItem])

  if (!show || nodeList.length === 0) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
      onClick={close}
    >
      <div
        className="flex gap-3 p-4 rounded-xl max-w-[90vw] overflow-x-auto"
        style={{ backgroundColor: 'rgba(30, 30, 36, 0.95)', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {nodeList.map((node, i) => {
          const panel = workspace?.panels[node.panelId]
          const type = panel?.type || 'terminal'
          const title = panel?.title || 'Panel'
          const isSelected = i === selectedIndex
          const thumb = thumbnails[node.id]

          return (
            <div
              key={node.id}
              ref={isSelected ? selectedRef : undefined}
              className="flex flex-col items-center gap-2 rounded-lg cursor-pointer transition-all"
              style={{
                backgroundColor: isSelected ? 'rgba(74, 158, 255, 0.15)' : 'transparent',
                border: isSelected ? '2px solid rgba(74, 158, 255, 0.6)' : '2px solid transparent',
                padding: 8,
                minWidth: 140,
                transform: isSelected ? 'scale(1.05)' : 'scale(1)',
              }}
              onClick={() => selectItem(i)}
            >
              {/* Preview thumbnail */}
              <div
                style={{
                  width: 130,
                  height: 90,
                  borderRadius: 6,
                  overflow: 'hidden',
                  backgroundColor: '#1E1E24',
                  border: `1px solid ${panelColor(type)}33`,
                  position: 'relative',
                }}
              >
                {thumb ? (
                  <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <PanelIcon type={type} />
                  </div>
                )}
              </div>
              {/* Title */}
              <div className="flex items-center gap-1.5">
                <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: panelColor(type) }} />
                <span className="text-xs text-white/80 truncate max-w-[110px]">{title}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
