import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUIStore } from '../stores/uiStore'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useSelectedWorkspace } from '../stores/appStore'
import type { PanelType } from '../../shared/types'

function panelColor(type: PanelType): string {
  switch (type) {
    case 'terminal': return '#34C759'
    case 'browser': return '#007AFF'
    case 'editor': return '#FF9500'
    case 'git': return '#FF3B30'
    case 'fileExplorer': return '#5AC8FA'
    case 'projectList': return '#FFD60A'
    case 'canvas': return '#BF5AF2'
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
  const canvasApi = useCanvasStoreApi()
  const nodes = useCanvasStoreContext((s) => s.nodes)
  const focusedNodeId = useCanvasStoreContext((s) => s.focusedNodeId)
  const workspace = useSelectedWorkspace()

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
    canvasApi.getState().focusAndCenter(node.id)
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

  // Uniform tile size so the grid aligns cleanly. Thumbnails keep their
  // aspect ratio via `objectFit: contain` inside the fixed box.
  const TILE_W = 220
  const TILE_H = 140

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-8 bg-black/60"
      onClick={close}
    >
      <div
        className="rounded-3xl bg-surface-4/90 backdrop-blur-2xl border border-white/20 shadow-[0_24px_64px_rgba(0,0,0,0.5)] p-6 overflow-y-auto [&::-webkit-scrollbar]:hidden"
        style={{
          width: 'min(92vw, 1200px)',
          maxHeight: '82vh',
          scrollbarWidth: 'none',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="grid gap-5"
          style={{
            gridTemplateColumns: `repeat(auto-fit, ${TILE_W}px)`,
            justifyContent: 'center',
          }}
        >
          {nodeList.map((node, i) => {
            const panel = workspace?.panels[node.panelId]
            const type = panel?.type || 'terminal'
            const title = panel?.title || 'Panel'
            const isSelected = i === selectedIndex
            const color = panelColor(type)
            const thumb = thumbnails[node.id]

            return (
              <div
                key={node.id}
                ref={isSelected ? selectedRef : undefined}
                className="flex flex-col items-center cursor-pointer transition-all duration-150"
                style={{
                  opacity: isSelected ? 1 : 0.65,
                  transform: isSelected ? 'scale(1.04)' : 'scale(1)',
                }}
                onClick={() => selectItem(i)}
              >
                <div
                  style={{
                    width: TILE_W,
                    height: TILE_H,
                    borderRadius: 10,
                    overflow: 'hidden',
                    border: isSelected ? `2px solid ${color}` : `1px solid rgba(255,255,255,0.08)`,
                    boxShadow: isSelected
                      ? `0 0 24px ${color}44, 0 4px 20px rgba(0,0,0,0.4)`
                      : '0 2px 10px rgba(0,0,0,0.25)',
                    transition: 'border-color 0.15s, box-shadow 0.15s, transform 0.15s',
                    backgroundColor: 'var(--surface-5)',
                  }}
                >
                  {thumb ? (
                    <img
                      src={thumb}
                      alt={title}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  ) : (
                    <div style={{
                      width: '100%', height: '100%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'var(--text-muted)', fontSize: 11,
                    }}>
                      ...
                    </div>
                  )}
                </div>
                <span
                  className="truncate text-center mt-2"
                  style={{
                    fontSize: 12,
                    color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                    maxWidth: TILE_W,
                    fontWeight: isSelected ? 600 : 400,
                  }}
                >
                  {title}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
