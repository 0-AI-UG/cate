import React, { useCallback, useEffect, useState } from 'react'
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
  }
}

function PanelIcon({ type }: { type: PanelType }) {
  const color = panelColor(type)
  const size = 24
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
  }
}

export function PanelSwitcher() {
  const show = useUIStore((s) => s.showPanelSwitcher)
  const nodes = useCanvasStore((s) => s.nodes)
  const workspace = useAppStore((s) => s.workspaces.find(w => w.id === s.selectedWorkspaceId))

  const nodeList = Object.values(nodes).sort((a, b) => a.creationIndex - b.creationIndex)
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Reset selection when opened
  useEffect(() => {
    if (show) {
      // Start at next panel (index 1) if multiple panels exist
      setSelectedIndex(nodeList.length > 1 ? 1 : 0)
    }
  }, [show])

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
      if (e.key === 'Tab' && e.ctrlKey) {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIndex((prev) => (prev + (e.shiftKey ? -1 : 1) + nodeList.length) % nodeList.length)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        close()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        selectItem(selectedIndex)
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      // When Ctrl is released, confirm selection
      if (e.key === 'Control') {
        selectItem(selectedIndex)
      }
    }

    document.addEventListener('keydown', handleKeyDown, { capture: true })
    document.addEventListener('keyup', handleKeyUp, { capture: true })
    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true })
      document.removeEventListener('keyup', handleKeyUp, { capture: true })
    }
  }, [show, selectedIndex, nodeList, close, selectItem])

  if (!show || nodeList.length === 0) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      onClick={close}
    >
      <div
        className="flex gap-3 p-4 rounded-xl"
        style={{ backgroundColor: 'rgba(30, 30, 36, 0.95)', border: '1px solid rgba(255,255,255,0.1)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {nodeList.map((node, i) => {
          const panel = workspace?.panels[node.panelId]
          const type = panel?.type || 'terminal'
          const title = panel?.title || 'Panel'
          const isSelected = i === selectedIndex

          return (
            <div
              key={node.id}
              className="flex flex-col items-center gap-2 p-3 rounded-lg cursor-pointer transition-colors"
              style={{
                backgroundColor: isSelected ? 'rgba(74, 158, 255, 0.2)' : 'transparent',
                border: isSelected ? '1.5px solid rgba(74, 158, 255, 0.5)' : '1.5px solid transparent',
                minWidth: 80,
              }}
              onClick={() => selectItem(i)}
            >
              <PanelIcon type={type} />
              <span className="text-xs text-white/80 truncate max-w-[80px]">{title}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
