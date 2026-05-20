import React, { useCallback, useRef, useState, useEffect } from 'react'
import type { CanvasRegion } from '../../shared/types'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import type { NativeContextMenuItem } from '../../shared/electron-api'
import { useAppStore, getCanvasOpsById } from '../stores/appStore'
import { confirmDeleteRegion } from '../lib/confirmDeleteRegion'

// Preset region colors
const REGION_COLORS = [
  'rgba(0, 128, 255, 0.08)',    // blue (default)
  'rgba(0, 255, 0, 0.08)',      // green
  'rgba(255, 128, 0, 0.08)',    // orange
  'rgba(255, 0, 0, 0.08)',      // red
  'rgba(170, 0, 255, 0.08)',    // purple
  'rgba(255, 255, 0, 0.08)',    // yellow
  'rgba(0, 255, 255, 0.08)',    // teal
  'rgba(255, 0, 128, 0.08)',    // pink
]

// Parse rgba(...) string → { r, g, b, a }
function parseRgba(str: string): { r: number; g: number; b: number; a: number } {
  const m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/)
  if (!m) return { r: 74, g: 158, b: 255, a: 0.08 }
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] ? +m[4] : 1 }
}

const REGION_MIN_SIZE = 100

interface Props {
  region: CanvasRegion
  zoomLevel: number
}

type ResizeHandle = 'top' | 'bottom' | 'left' | 'right' | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'

const HANDLE_CURSORS: Record<ResizeHandle, string> = {
  top: 'ns-resize',
  bottom: 'ns-resize',
  left: 'ew-resize',
  right: 'ew-resize',
  topLeft: 'nwse-resize',
  topRight: 'nesw-resize',
  bottomLeft: 'nesw-resize',
  bottomRight: 'nwse-resize',
}

const CanvasRegionComponent: React.FC<Props> = ({ region, zoomLevel }) => {
  const canvasApi = useCanvasStoreApi()
  const isSelected = useCanvasStoreContext((s) => s.selectedRegionIds.has(region.id))
  const isDropTarget = useCanvasStoreContext((s) => s.dropTargetRegionId === region.id)
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number; lastClientX: number; lastClientY: number } | null>(null)
  const listenersAbortRef = useRef<AbortController | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(region.label)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input when editing
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  // Clean up any active drag/resize listeners on unmount
  useEffect(() => {
    return () => { listenersAbortRef.current?.abort() }
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) {
      e.stopPropagation()
      return
    }
    if (e.button !== 0) return
    e.stopPropagation()

    // Shift-click: toggle selection
    if (e.shiftKey) {
      canvasApi.getState().toggleRegionSelection(region.id)
      return
    }

    // Select this region if not already selected
    if (!canvasApi.getState().selectedRegionIds.has(region.id)) {
      canvasApi.getState().selectRegions([region.id])
    }

    // Start drag
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: region.origin.x,
      originY: region.origin.y,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
    }

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const zoom = canvasApi.getState().zoomLevel

      const state = canvasApi.getState()

      // Determine if this is truly a multi-drag (more than just this region + its children)
      const hasOtherRegions = state.selectedRegionIds.size > 1
      const hasExternalNodes = (() => {
        for (const nodeId of state.selectedNodeIds) {
          const n = state.nodes[nodeId]
          if (n && n.regionId !== region.id) return true
        }
        return false
      })()
      const isMultiDrag = hasOtherRegions || hasExternalNodes

      if (isMultiDrag) {
        // Multi-drag: use incremental deltas to avoid compounding
        const incrDx = (ev.clientX - dragRef.current.lastClientX) / zoom
        const incrDy = (ev.clientY - dragRef.current.lastClientY) / zoom
        dragRef.current.lastClientX = ev.clientX
        dragRef.current.lastClientY = ev.clientY

        // Batch all node + region moves into a single store update
        canvasApi.setState((s) => {
          const updatedNodes = { ...s.nodes }
          for (const nodeId of state.selectedNodeIds) {
            const n = s.nodes[nodeId]
            if (n) updatedNodes[nodeId] = { ...n, origin: { x: n.origin.x + incrDx, y: n.origin.y + incrDy } }
          }
          const updatedRegions = { ...s.regions }
          for (const rid of state.selectedRegionIds) {
            const r = s.regions[rid]
            if (r) updatedRegions[rid] = { ...r, origin: { x: r.origin.x + incrDx, y: r.origin.y + incrDy } }
          }
          return { nodes: updatedNodes, regions: updatedRegions }
        })
      } else {
        // Single-region drag: use moveRegion which cascades to contained nodes
        const totalDx = (ev.clientX - dragRef.current.startX) / zoom
        const totalDy = (ev.clientY - dragRef.current.startY) / zoom
        canvasApi.getState().moveRegion(region.id, {
          x: dragRef.current.originX + totalDx,
          y: dragRef.current.originY + totalDy,
        })
      }
    }

    const handleMouseUp = () => {
      listenersAbortRef.current?.abort()
      listenersAbortRef.current = null
      dragRef.current = null
    }

    listenersAbortRef.current?.abort()
    const controller = new AbortController()
    listenersAbortRef.current = controller
    const { signal } = controller
    window.addEventListener('mousemove', handleMouseMove, { signal })
    window.addEventListener('mouseup', handleMouseUp, { signal })
  }, [region.id, region.origin.x, region.origin.y])

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setEditValue(region.label)
    setIsEditing(true)
  }, [region.label])

  const handleRenameSubmit = useCallback(() => {
    if (editValue.trim()) {
      canvasApi.getState().renameRegion(region.id, editValue.trim())
    }
    setIsEditing(false)
  }, [region.id, editValue])

  const extractRegionToNewCanvas = useCallback(() => {
    const state = canvasApi.getState()
    const src = state.regions[region.id]
    if (!src) return
    const containedNodes = Object.values(state.nodes).filter((n) => n.regionId === region.id)

    // Shift so region origin becomes (200, 200) in the new canvas
    const TARGET_X = 200
    const TARGET_Y = 200
    const dx = TARGET_X - src.origin.x
    const dy = TARGET_Y - src.origin.y

    const newRegion: CanvasRegion = {
      ...src,
      origin: { x: src.origin.x + dx, y: src.origin.y + dy },
      zOrder: -1000,
    }
    const newNodes = containedNodes.map((n) => ({
      ...n,
      origin: { x: n.origin.x + dx, y: n.origin.y + dy },
    }))

    const workspaceId = useAppStore.getState().selectedWorkspaceId
    if (!workspaceId) return
    const newPanelId = useAppStore.getState().createCanvas(workspaceId)
    if (!newPanelId) return

    // Wait for the new canvas store to register, then transfer nodes+region.
    let attempts = 0
    const tryTransfer = () => {
      attempts++
      const ops = getCanvasOpsById(newPanelId)
      if (!ops) {
        if (attempts < 120) requestAnimationFrame(tryTransfer)
        return
      }
      ops.storeApi.setState((s) => {
        const addedNodes = { ...s.nodes }
        for (const n of newNodes) addedNodes[n.id] = n
        return {
          nodes: addedNodes,
          regions: { ...s.regions, [newRegion.id]: newRegion },
        }
      })

      // Remove from current canvas
      canvasApi.setState((s) => {
        const { [region.id]: _r, ...restRegions } = s.regions
        const restNodes = { ...s.nodes }
        for (const n of newNodes) delete restNodes[n.id]
        const nextRegionSel = new Set(s.selectedRegionIds)
        nextRegionSel.delete(region.id)
        const nextNodeSel = new Set(s.selectedNodeIds)
        for (const n of newNodes) nextNodeSel.delete(n.id)
        return {
          regions: restRegions,
          nodes: restNodes,
          selectedRegionIds: nextRegionSel,
          selectedNodeIds: nextNodeSel,
        }
      })
    }
    requestAnimationFrame(tryTransfer)
  }, [region.id, canvasApi])

  const REGION_COLOR_LABELS = ['Blue', 'Green', 'Orange', 'Red', 'Purple', 'Yellow', 'Teal', 'Pink']

  const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!window.electronAPI) return
    const colorSubmenu: NativeContextMenuItem[] = REGION_COLORS.map((color, i) => ({
      id: `color:${i}`,
      label: region.color === color ? `${REGION_COLOR_LABELS[i]} ✓` : REGION_COLOR_LABELS[i],
    }))
    const cwdLabel = region.defaultCwd
      ? `Default Folder: …/${region.defaultCwd.split('/').filter(Boolean).slice(-2).join('/')}`
      : 'Set Default Folder…'
    const id = await window.electronAPI.showContextMenu([
      { id: 'rename', label: 'Rename' },
      { label: 'Change Color', submenu: colorSubmenu },
      { id: 'set-cwd', label: cwdLabel },
      ...(region.defaultCwd ? [{ id: 'clear-cwd', label: 'Clear Default Folder' }] : []),
      { type: 'separator' as const },
      { id: 'extract', label: 'Extract to New Canvas' },
      { type: 'separator' as const },
      { id: 'dissolve', label: 'Dissolve Region' },
      { id: 'delete', label: 'Delete Region…' },
    ])
    if (!id) return
    if (id === 'rename') {
      setEditValue(region.label)
      setIsEditing(true)
      return
    }
    if (id.startsWith('color:')) {
      const idx = parseInt(id.slice(6), 10)
      canvasApi.getState().updateRegionColor(region.id, REGION_COLORS[idx])
      return
    }
    if (id === 'set-cwd') {
      const path = await window.electronAPI.openFolderDialog()
      if (path) canvasApi.getState().setRegionDefaultCwd(region.id, path)
      return
    }
    if (id === 'clear-cwd') {
      canvasApi.getState().setRegionDefaultCwd(region.id, undefined)
      return
    }
    switch (id) {
      case 'extract': extractRegionToNewCanvas(); break
      case 'dissolve': canvasApi.getState().dissolveRegion(region.id); break
      case 'delete': {
        const state = canvasApi.getState()
        const panelCount = Object.values(state.nodes).filter((n) => n.regionId === region.id).length
        if (panelCount === 0) {
          state.removeRegion(region.id)
          break
        }
        const choice = await confirmDeleteRegion(panelCount)
        if (choice === 'cancel') break
        state.selectRegions([region.id])
        state.deleteSelection(choice === 'with-contents')
        break
      }
    }
  }, [region.id, region.label, region.color, region.defaultCwd, canvasApi])

  // Resize handle mouse down
  const handleResizeStart = useCallback((e: React.MouseEvent, handle: ResizeHandle) => {
    e.preventDefault()
    e.stopPropagation()

    const startX = e.clientX
    const startY = e.clientY
    const startOrigin = { ...region.origin }
    const startSize = { ...region.size }

    const handleMouseMove = (ev: MouseEvent) => {
      const zoom = canvasApi.getState().zoomLevel
      const dx = (ev.clientX - startX) / zoom
      const dy = (ev.clientY - startY) / zoom
      const h = handle.toLowerCase()

      let newX = startOrigin.x
      let newY = startOrigin.y
      let newW = startSize.width
      let newH = startSize.height

      if (h.includes('right')) { newW += dx }
      if (h.includes('left')) { newX += dx; newW -= dx }
      if (h.includes('bottom')) { newH += dy }
      if (h.includes('top')) { newY += dy; newH -= dy }

      // Clamp minimum
      if (newW < REGION_MIN_SIZE) {
        const excess = REGION_MIN_SIZE - newW
        newW = REGION_MIN_SIZE
        if (h.includes('left')) newX -= excess
      }
      if (newH < REGION_MIN_SIZE) {
        const excess = REGION_MIN_SIZE - newH
        newH = REGION_MIN_SIZE
        if (h.includes('top')) newY -= excess
      }

      canvasApi.getState().resizeRegion(region.id, { width: newW, height: newH }, { x: newX, y: newY })
    }

    const handleMouseUp = () => {
      listenersAbortRef.current?.abort()
      listenersAbortRef.current = null
    }

    listenersAbortRef.current?.abort()
    const controller = new AbortController()
    listenersAbortRef.current = controller
    const { signal } = controller
    window.addEventListener('mousemove', handleMouseMove, { signal })
    window.addEventListener('mouseup', handleMouseUp, { signal })
  }, [region.id, region.origin, region.size])

  const handleSize = 8

  return (
    <>
      <div
        data-region-id={region.id}
        style={{
          position: 'absolute',
          left: region.origin.x,
          top: region.origin.y,
          width: region.size.width,
          height: region.size.height,
          background: `linear-gradient(135deg, rgba(${parseRgba(region.color).r}, ${parseRgba(region.color).g}, ${parseRgba(region.color).b}, ${isDropTarget ? 0.22 : 0.10}) 0%, rgba(${parseRgba(region.color).r}, ${parseRgba(region.color).g}, ${parseRgba(region.color).b}, ${isDropTarget ? 0.12 : 0.04}) 100%)`,
          borderRadius: 0,
          border: isDropTarget
            ? `2px solid rgba(${parseRgba(region.color).r}, ${parseRgba(region.color).g}, ${parseRgba(region.color).b}, 1)`
            : isSelected
            ? `1.5px solid rgba(${parseRgba(region.color).r}, ${parseRgba(region.color).g}, ${parseRgba(region.color).b}, 0.9)`
            : `1px solid rgba(${parseRgba(region.color).r}, ${parseRgba(region.color).g}, ${parseRgba(region.color).b}, 0.35)`,
          boxShadow: isDropTarget
            ? `0 0 0 6px rgba(${parseRgba(region.color).r}, ${parseRgba(region.color).g}, ${parseRgba(region.color).b}, 0.18), inset 0 1px 0 var(--border-subtle)`
            : isSelected
            ? `0 0 0 4px rgba(${parseRgba(region.color).r}, ${parseRgba(region.color).g}, ${parseRgba(region.color).b}, 0.12), inset 0 1px 0 var(--border-subtle)`
            : `inset 0 1px 0 var(--border-subtle)`,
          transition: 'background 120ms ease, box-shadow 120ms ease, border-color 120ms ease',
          cursor: 'grab',
        }}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      >
        {/* Label */}
        {isEditing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameSubmit()
              if (e.key === 'Escape') setIsEditing(false)
              e.stopPropagation()
            }}
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 4,
              marginBottom: 8,
              fontSize: 18,
              fontWeight: 400,
              letterSpacing: 0.3,
              color: 'var(--text-primary)',
              textShadow: '0 1px 3px rgba(0, 0, 0, 0.7)',
              background: 'transparent',
              border: 'none',
              borderBottom: '1px solid var(--text-primary)',
              borderRadius: 0,
              padding: 0,
              outline: 'none',
              minWidth: 60,
              transform: `scale(${1 / Math.max(zoomLevel, 0.6)})`,
              transformOrigin: 'bottom left',
            }}
          />
        ) : (
          <div
            onMouseDown={(e) => { e.stopPropagation() }}
            onClick={(e) => {
              e.stopPropagation()
              setEditValue(region.label)
              setIsEditing(true)
            }}
            title="Click to rename"
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 4,
              marginBottom: 8,
              fontSize: 18,
              fontWeight: 400,
              letterSpacing: 0.3,
              color: 'var(--text-primary)',
              textShadow: '0 1px 3px rgba(0, 0, 0, 0.7)',
              whiteSpace: 'nowrap',
              userSelect: 'none',
              cursor: 'text',
              transform: `scale(${1 / Math.max(zoomLevel, 0.6)})`,
              transformOrigin: 'bottom left',
            }}
          >
            {region.label}
          </div>
        )}
      </div>

      {/* Resize handles — shown when selected */}
      {isSelected && (
        <>
          {/* Corner handles */}
          {(['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as ResizeHandle[]).map((handle) => (
            <div
              key={handle}
              style={{
                position: 'absolute',
                left: region.origin.x + (handle.includes('Left') ? -handleSize / 2 : region.size.width - handleSize / 2),
                top: region.origin.y + (handle.includes('top') || handle === 'topLeft' || handle === 'topRight' ? -handleSize / 2 : region.size.height - handleSize / 2),
                width: handleSize,
                height: handleSize,
                backgroundColor: 'rgba(74, 158, 255, 0.9)',
                borderRadius: 2,
                cursor: HANDLE_CURSORS[handle],
                zIndex: 1,
              }}
              onMouseDown={(e) => handleResizeStart(e, handle)}
            />
          ))}
          {/* Edge handles */}
          {(['top', 'bottom', 'left', 'right'] as ResizeHandle[]).map((handle) => {
            const isHoriz = handle === 'top' || handle === 'bottom'
            return (
              <div
                key={handle}
                style={{
                  position: 'absolute',
                  left: region.origin.x + (handle === 'left' ? -handleSize / 2 : handle === 'right' ? region.size.width - handleSize / 2 : region.size.width / 2 - handleSize / 2),
                  top: region.origin.y + (handle === 'top' ? -handleSize / 2 : handle === 'bottom' ? region.size.height - handleSize / 2 : region.size.height / 2 - handleSize / 2),
                  width: isHoriz ? handleSize : handleSize,
                  height: isHoriz ? handleSize : handleSize,
                  backgroundColor: 'rgba(74, 158, 255, 0.7)',
                  borderRadius: 2,
                  cursor: HANDLE_CURSORS[handle],
                  zIndex: 1,
                }}
                onMouseDown={(e) => handleResizeStart(e, handle)}
              />
            )
          })}
        </>
      )}

    </>
  )
}

export default React.memo(CanvasRegionComponent)
