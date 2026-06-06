// =============================================================================
// DockZone — renders a dock zone, reading the layout tree from dockStore
// and recursively rendering splits and tab stacks.
// Registers as a drop zone for dock-aware drag-and-drop.
// =============================================================================

import React, { useCallback, useEffect, useRef } from 'react'
import { useDockStoreContext } from '../stores/DockStoreContext'
import type { DockZonePosition, DockLayoutNode, PanelState } from '../../shared/types'
import DockTabStack from './DockTabStack'
import DockSplitContainer from './DockSplitContainer'
import { registerDropZone } from '../drag'
import { openFileAsPanel } from '../lib/fs/fileRouting'
import { setPendingReveal } from '../lib/editor/editorReveal'
import { useAppStore } from '../stores/appStore'

interface DockZoneProps {
  position: DockZonePosition
  renderPanel: (panelId: string) => React.ReactNode
  getPanelTitle: (panelId: string) => string
  onClosePanel?: (panelId: string) => void
  getPanel?: (panelId: string) => PanelState | undefined
  workspaceId?: string
  onPanelRemoved?: (panelId: string) => void
  onPanelRenamed?: (panelId: string, title: string) => void
}

export default function DockZone({ position, renderPanel, getPanelTitle, onClosePanel, getPanel, workspaceId, onPanelRemoved, onPanelRenamed }: DockZoneProps) {
  const zone = useDockStoreContext((s) => s.zones[position])
  const zoneRef = useRef<HTMLDivElement>(null)

  // Register this zone as a drop target
  useEffect(() => {
    return registerDropZone({
      id: `zone-${position}`,
      zone: position,
      getRect: () => zoneRef.current?.getBoundingClientRect() ?? null,
    })
  }, [position])

  // Native file drop (from Search results, the Explorer, or the OS) → open the
  // file(s) as editor tabs in this zone. The drop indicator itself is rendered
  // globally by <FileDropOverlay/> (this div is marked data-filedrop="dock").
  // The canvas handles its own area and stops propagation, so canvas drops
  // still open floating nodes.
  const handleFileDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes('application/cate-file') || e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleFileDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      const multiData = e.dataTransfer.getData('application/cate-files')
      const singlePath = e.dataTransfer.getData('application/cate-file')
      let paths: string[] = []
      if (multiData) {
        try { paths = JSON.parse(multiData) } catch { /* ignore */ }
      }
      if (paths.length === 0 && singlePath) paths = [singlePath]
      if (paths.length === 0 && e.dataTransfer.files.length > 0) {
        for (const f of Array.from(e.dataTransfer.files)) {
          const p = (f as { path?: string }).path
          if (p) paths.push(p)
        }
      }
      if (paths.length === 0) return

      e.preventDefault()
      e.stopPropagation()

      let lineReveal: { path: string; line: number; column?: number } | null = null
      const lineRaw = e.dataTransfer.getData('application/cate-file-line')
      if (lineRaw) {
        try { lineReveal = JSON.parse(lineRaw) } catch { /* ignore */ }
      }

      const wsId = workspaceId ?? useAppStore.getState().selectedWorkspaceId
      if (!wsId) return
      for (const filePath of paths) {
        let isDir = false
        try {
          const st = await window.electronAPI.fsStat(filePath, wsId)
          isDir = !!st?.isDirectory
        } catch { /* treat as file */ }
        if (isDir) continue // dock tabs don't host folders
        const panelId = openFileAsPanel(wsId, filePath, undefined, { target: 'dock', zone: position })
        if (panelId && lineReveal && lineReveal.path === filePath) {
          setPendingReveal(panelId, { line: lineReveal.line, column: lineReveal.column })
        }
      }
    },
    [workspaceId, position],
  )

  const renderNode = useCallback(
    (node: DockLayoutNode): React.ReactNode => {
      if (node.type === 'tabs') {
        return (
          <DockTabStack
            key={node.id}
            stack={node}
            zone={position}
            renderPanel={renderPanel}
            getPanelTitle={getPanelTitle}
            onClosePanel={onClosePanel}
            getPanel={getPanel}
            workspaceId={workspaceId}
            onPanelRemoved={onPanelRemoved}
            onPanelRenamed={onPanelRenamed}
          />
        )
      }
      return (
        <DockSplitContainer
          key={node.id}
          node={node}
          renderNode={renderNode}
        />
      )
    },
    [renderPanel, getPanelTitle, onClosePanel],
  )

  if (!zone.visible) return null

  // Center zone fills its parent (100%); side zones use fixed size
  const isCenter = position === 'center'
  const style: React.CSSProperties = isCenter
    ? { width: '100%', height: '100%' }
    : {
        [position === 'bottom' ? 'height' : 'width']: `${zone.size}px`,
        flexShrink: 0,
      }

  return (
    <div
      ref={zoneRef}
      data-dock-zone={position}
      data-filedrop="dock"
      data-filedrop-id={position}
      className={`flex flex-col overflow-hidden relative ${isCenter ? 'bg-canvas-bg' : 'bg-surface-4'}`}
      style={style}
      onDragOver={handleFileDragOver}
      onDrop={handleFileDrop}
    >
      {zone.layout ? renderNode(zone.layout) : (
        // Empty center zone — show background
        isCenter && <div className="w-full h-full" />
      )}
    </div>
  )
}
