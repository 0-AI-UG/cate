import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
    case 'fileExplorer': return '#5AC8FA'
    case 'projectList': return '#FFD60A'
  }
}

/**
 * Crop panel regions from a pre-captured page screenshot.
 * Bounding rects are collected from the DOM at the moment this runs
 * (before the overlay is visible).
 */
function useCroppedThumbnails(
  pageScreenshot: string | null,
  nodeIds: string[],
) {
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})

  // Collect bounding rects synchronously on first render (overlay not yet painted)
  const rectsRef = useRef<Record<string, DOMRect>>({})
  useMemo(() => {
    const rects: Record<string, DOMRect> = {}
    for (const id of nodeIds) {
      const el = document.querySelector(`[data-node-id="${id}"]`)
      if (el) rects[id] = el.getBoundingClientRect()
    }
    rectsRef.current = rects
  }, [nodeIds.join(',')])

  useEffect(() => {
    if (!pageScreenshot) return
    const rects = rectsRef.current

    const img = new Image()
    img.onload = () => {
      const dpr = window.devicePixelRatio || 1
      const result: Record<string, string> = {}

      for (const id of nodeIds) {
        const rect = rects[id]
        if (!rect || rect.width < 1 || rect.height < 1) continue

        // Source region in the screenshot (at device pixel ratio)
        const sx = Math.round(rect.left * dpr)
        const sy = Math.round(rect.top * dpr)
        const sw = Math.round(rect.width * dpr)
        const sh = Math.round(rect.height * dpr)

        // Skip if out of bounds
        if (sx < 0 || sy < 0 || sx + sw > img.width || sy + sh > img.height) continue

        const canvas = document.createElement('canvas')
        canvas.width = sw
        canvas.height = sh
        const ctx = canvas.getContext('2d')
        if (!ctx) continue

        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
        result[id] = canvas.toDataURL()
      }

      setThumbnails(result)
    }
    img.src = pageScreenshot
  }, [pageScreenshot, nodeIds.join(',')])

  return thumbnails
}

export function PanelSwitcher() {
  const show = useUIStore((s) => s.showPanelSwitcher)
  const pageScreenshot = useUIStore((s) => s.panelSwitcherScreenshot)
  const nodes = useCanvasStore((s) => s.nodes)
  const focusedNodeId = useCanvasStore((s) => s.focusedNodeId)
  const workspace = useAppStore((s) => s.workspaces.find(w => w.id === s.selectedWorkspaceId))

  const nodeList = Object.values(nodes).sort((a, b) => a.creationIndex - b.creationIndex)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedRef = useRef<HTMLDivElement>(null)

  const thumbnails = useCroppedThumbnails(show ? pageScreenshot : null, nodeList.map(n => n.id))

  useEffect(() => {
    if (show) {
      const focusedIdx = nodeList.findIndex(n => n.id === focusedNodeId)
      const nextIdx = focusedIdx >= 0 ? (focusedIdx + 1) % nodeList.length : 0
      setSelectedIndex(nextIdx)
    } else {
      // Clear screenshot when closing
      useUIStore.setState({ panelSwitcherScreenshot: null })
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

  useEffect(() => {
    if (!show) return
    const handler = () => advanceSelection()
    window.addEventListener('panel-switcher-next', handler)
    return () => window.removeEventListener('panel-switcher-next', handler)
  }, [show, advanceSelection])

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
          const thumb = thumbnails[node.id]

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
                {thumb ? (
                  <img
                    src={thumb}
                    alt={title}
                    style={{ width: '100%', height: '100%', objectFit: 'fill', display: 'block' }}
                  />
                ) : (
                  <div style={{
                    width: '100%', height: '100%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'rgba(255,255,255,0.15)', fontSize: 10,
                  }}>
                    ...
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
