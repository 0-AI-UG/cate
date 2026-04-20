import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal, Globe, FileText, GitBranch, TreeStructure, SquaresFour, List } from '@phosphor-icons/react'
import { useUIStore } from '../stores/uiStore'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useSelectedWorkspace } from '../stores/appStore'
import { useDockStore } from '../stores/dockStore'
import { findTabStack } from '../stores/dockTreeUtils'
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

function PlaceholderIcon({ type, color }: { type: PanelType; color: string }) {
  const size = 44
  switch (type) {
    case 'terminal':     return <Terminal size={size} color={color} weight="light" />
    case 'browser':      return <Globe size={size} color={color} weight="light" />
    case 'editor':       return <FileText size={size} color={color} weight="light" />
    case 'git':          return <GitBranch size={size} color={color} weight="light" />
    case 'fileExplorer': return <TreeStructure size={size} color={color} weight="light" />
    case 'projectList':  return <List size={size} color={color} weight="light" />
    case 'canvas':       return <SquaresFour size={size} color={color} weight="light" />
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

type SwitcherItem =
  | {
      kind: 'canvas'
      id: string
      panelId: string
      nodeId: string
      type: PanelType
      title: string
      aspect: number
    }
  | {
      kind: 'dock'
      id: string
      panelId: string
      type: PanelType
      title: string
    }

export function PanelSwitcher() {
  const show = useUIStore((s) => s.showPanelSwitcher)
  const pageScreenshot = useUIStore((s) => s.panelSwitcherScreenshot)
  const canvasApi = useCanvasStoreApi()
  const nodes = useCanvasStoreContext((s) => s.nodes)
  const focusedNodeId = useCanvasStoreContext((s) => s.focusedNodeId)
  const workspace = useSelectedWorkspace()

  // Canvas panels — rendered with node-based thumbnails + real aspect ratios.
  const canvasItems: SwitcherItem[] = useMemo(() => {
    return Object.values(nodes)
      .sort((a, b) => a.creationIndex - b.creationIndex)
      .map((n) => {
        const panel = workspace?.panels[n.panelId]
        return {
          kind: 'canvas' as const,
          id: n.id,
          panelId: n.panelId,
          nodeId: n.id,
          type: (panel?.type ?? 'terminal') as PanelType,
          title: panel?.title ?? 'Panel',
          aspect: n.size.width / Math.max(n.size.height, 1),
        }
      })
  }, [nodes, workspace])

  // Dock-zone panels — file explorer, git, project list, canvas host, etc.
  // These live in workspace.panels but have no canvas node.
  const dockItems: SwitcherItem[] = useMemo(() => {
    if (!workspace) return []
    const canvasPanelIds = new Set(canvasItems.map((i) => i.panelId))
    return Object.values(workspace.panels)
      .filter((p) => !canvasPanelIds.has(p.id))
      .map((p) => ({
        kind: 'dock' as const,
        id: p.id,
        panelId: p.id,
        type: p.type,
        title: p.title,
      }))
  }, [workspace, canvasItems])

  const items: SwitcherItem[] = useMemo(() => [...canvasItems, ...dockItems], [canvasItems, dockItems])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedRef = useRef<HTMLDivElement>(null)

  const canvasNodeIds = useMemo(
    () => canvasItems.flatMap((i) => (i.kind === 'canvas' ? [i.nodeId] : [])),
    [canvasItems],
  )
  const thumbnails = useCroppedThumbnails(show ? pageScreenshot : null, canvasNodeIds)

  useEffect(() => {
    if (show) {
      const focusedIdx = items.findIndex((it) => it.kind === 'canvas' && it.id === focusedNodeId)
      const nextIdx = focusedIdx >= 0 ? (focusedIdx + 1) % items.length : 0
      setSelectedIndex(nextIdx)
    } else {
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
    const item = items[index]
    if (!item) return
    if (item.kind === 'canvas') {
      canvasApi.getState().focusAndCenter(item.nodeId)
    } else {
      // Dock panel: reveal its zone (unhide if collapsed) and activate its tab.
      const dock = useDockStore.getState()
      const loc = dock.getPanelLocation(item.panelId)
      if (loc && loc.type === 'dock') {
        const zone = dock.zones[loc.zone]
        if (!zone.visible) dock.toggleZone(loc.zone)
        if (zone.layout) {
          const stack = findTabStack(zone.layout, loc.stackId)
          if (stack) {
            const idx = stack.panelIds.indexOf(item.panelId)
            if (idx >= 0) dock.setActiveTab(loc.stackId, idx)
          }
        }
      }
    }
    close()
  }, [items, canvasApi, close])

  const advanceSelection = useCallback(() => {
    setSelectedIndex((prev) => (prev + 1) % items.length)
  }, [items.length])

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
        setSelectedIndex((prev) => (prev - 1 + items.length) % items.length)
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
  }, [show, selectedIndex, items, close, selectItem, advanceSelection])

  if (!show || items.length === 0) return null

  // Fixed tile width; height follows each node's true aspect ratio so the
  // grid flows as real masonry. Clamped so extreme aspects don't produce
  // absurdly tall/short tiles.
  const TILE_W = 220
  const MIN_TILE_H = 110
  const MAX_TILE_H = 260

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80"
      onClick={close}
    >
      {/* Scroll container — the flex centering on its inner grid lives in a
          separate layer so `justify-center` isn't fighting `overflow-y-auto`
          on the same element (caused left-hugging in the previous pass). */}
      <div
        className="absolute inset-0 overflow-y-auto [&::-webkit-scrollbar]:hidden flex items-start justify-center p-10"
        style={{ scrollbarWidth: 'none' }}
        onClick={close}
      >
        <div
          className="[column-gap:20px]"
          style={{
            width: 'min(92vw, 1200px)',
            columnWidth: `${TILE_W}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((item, i) => {
            const type = item.type
            const title = item.title
            const isSelected = i === selectedIndex
            const color = panelColor(type)
            const thumb = item.kind === 'canvas' ? thumbnails[item.nodeId] : undefined

            // Canvas items use the node's real aspect; dock items get a
            // uniform 4:3 so their tiles stay grid-friendly.
            const aspect = item.kind === 'canvas' ? item.aspect : 4 / 3
            const rawH = TILE_W / aspect
            const tileH = Math.max(MIN_TILE_H, Math.min(MAX_TILE_H, rawH))

            return (
              <div
                key={item.id}
                ref={isSelected ? selectedRef : undefined}
                className="flex flex-col items-center cursor-pointer transition-all duration-150 mb-5"
                style={{
                  breakInside: 'avoid',
                  opacity: isSelected ? 1 : 0.75,
                  transform: isSelected ? 'scale(1.03)' : 'scale(1)',
                }}
                onClick={() => selectItem(i)}
              >
                <div
                  style={{
                    width: TILE_W,
                    height: tileH,
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
                    // Fallback when the node was off-screen at capture time:
                    // show a type-tinted icon + label so tiles still convey
                    // what panel they represent instead of a blank "...".
                    <div
                      style={{
                        width: '100%', height: '100%',
                        display: 'flex', flexDirection: 'column',
                        alignItems: 'center', justifyContent: 'center',
                        gap: 6,
                        background: `linear-gradient(135deg, ${color}12 0%, transparent 70%)`,
                      }}
                    >
                      <PlaceholderIcon type={type} color={color} />
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                        {type === 'fileExplorer' ? 'File Explorer' : type === 'projectList' ? 'Projects' : type}
                      </span>
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
