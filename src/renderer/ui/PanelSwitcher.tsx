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

/**
 * Capture real panel thumbnails by screenshotting the page and cropping
 * each panel's bounding rect.
 */
function usePanelScreenshots(show: boolean, nodeIds: string[]) {
  const [screenshots, setScreenshots] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!show || nodeIds.length === 0) return

    // Collect bounding rects BEFORE capturing (overlay isn't rendered yet on first frame)
    const rects: Record<string, DOMRect> = {}
    for (const id of nodeIds) {
      const el = document.querySelector(`[data-node-id="${id}"]`)
      if (el) rects[id] = el.getBoundingClientRect()
    }

    window.electronAPI.capturePage().then((dataUrl) => {
      if (!dataUrl) return

      const img = new Image()
      img.onload = () => {
        // Electron capturePage returns image at device pixel ratio
        const dpr = window.devicePixelRatio || 1
        const result: Record<string, string> = {}

        for (const id of nodeIds) {
          const rect = rects[id]
          if (!rect || rect.width === 0 || rect.height === 0) continue

          const canvas = document.createElement('canvas')
          const thumbW = 180
          const aspect = rect.width / rect.height
          const thumbH = thumbW / aspect
          canvas.width = thumbW * 2 // render at 2x for sharpness
          canvas.height = thumbH * 2
          const ctx = canvas.getContext('2d')
          if (!ctx) continue

          ctx.drawImage(
            img,
            rect.left * dpr, rect.top * dpr,
            rect.width * dpr, rect.height * dpr,
            0, 0,
            canvas.width, canvas.height,
          )
          result[id] = canvas.toDataURL()
        }

        setScreenshots(result)
      }
      img.src = dataUrl
    }).catch(() => {})
  }, [show, nodeIds.join(',')])

  return screenshots
}

export function PanelSwitcher() {
  const show = useUIStore((s) => s.showPanelSwitcher)
  const nodes = useCanvasStore((s) => s.nodes)
  const focusedNodeId = useCanvasStore((s) => s.focusedNodeId)
  const workspace = useAppStore((s) => s.workspaces.find(w => w.id === s.selectedWorkspaceId))

  const nodeList = Object.values(nodes).sort((a, b) => a.creationIndex - b.creationIndex)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedRef = useRef<HTMLDivElement>(null)

  const screenshots = usePanelScreenshots(show, nodeList.map(n => n.id))

  // Reset selection when opened — start at next panel after focused
  useEffect(() => {
    if (show) {
      const focusedIdx = nodeList.findIndex(n => n.id === focusedNodeId)
      const nextIdx = focusedIdx >= 0 ? (focusedIdx + 1) % nodeList.length : 0
      setSelectedIndex(nextIdx)
    }
  }, [show])

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

  const advanceSelection = useCallback(() => {
    setSelectedIndex((prev) => (prev + 1) % nodeList.length)
  }, [nodeList.length])

  // Listen for cycle event from useShortcuts (Cmd+E while open)
  useEffect(() => {
    if (!show) return
    const handler = () => advanceSelection()
    window.addEventListener('panel-switcher-next', handler)
    return () => window.removeEventListener('panel-switcher-next', handler)
  }, [show, advanceSelection])

  // Keyboard navigation
  useEffect(() => {
    if (!show) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        advanceSelection()
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
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [show, selectedIndex, nodeList, close, selectItem, advanceSelection])

  if (!show || nodeList.length === 0) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
      onClick={close}
    >
      <div
        className="flex gap-4 px-2 py-3 max-w-[90vw] overflow-x-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {nodeList.map((node, i) => {
          const panel = workspace?.panels[node.panelId]
          const type = panel?.type || 'terminal'
          const title = panel?.title || 'Panel'
          const isSelected = i === selectedIndex
          const color = panelColor(type)
          const screenshot = screenshots[node.id]

          // Real aspect ratio
          const maxThumbW = 180
          const maxThumbH = 120
          const aspect = node.size.width / Math.max(node.size.height, 1)
          let thumbW: number, thumbH: number
          if (aspect > maxThumbW / maxThumbH) {
            thumbW = maxThumbW
            thumbH = maxThumbW / aspect
          } else {
            thumbH = maxThumbH
            thumbW = maxThumbH * aspect
          }

          return (
            <div
              key={node.id}
              ref={isSelected ? selectedRef : undefined}
              className="flex flex-col items-center cursor-pointer transition-all duration-150"
              style={{
                opacity: isSelected ? 1 : 0.5,
                transform: isSelected ? 'scale(1.08)' : 'scale(1)',
              }}
              onClick={() => selectItem(i)}
            >
              <div
                style={{
                  width: thumbW,
                  height: thumbH,
                  borderRadius: 8,
                  overflow: 'hidden',
                  border: isSelected ? `2px solid ${color}` : '2px solid rgba(255,255,255,0.08)',
                  boxShadow: isSelected
                    ? `0 0 20px ${color}33, 0 4px 16px rgba(0,0,0,0.4)`
                    : '0 2px 8px rgba(0,0,0,0.3)',
                  transition: 'border-color 0.15s, box-shadow 0.15s',
                  backgroundColor: '#1E1E24',
                }}
              >
                {screenshot ? (
                  <img
                    src={screenshot}
                    alt={title}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                ) : (
                  <div style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'rgba(255,255,255,0.2)',
                    fontSize: 10,
                  }}>
                    Loading...
                  </div>
                )}
              </div>
              <span
                className="truncate text-center mt-2"
                style={{
                  fontSize: 11,
                  color: isSelected ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)',
                  maxWidth: thumbW,
                  fontWeight: isSelected ? 500 : 400,
                }}
              >
                {title}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
