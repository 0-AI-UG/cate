// =============================================================================
// CanvasPanel — a full canvas workspace that lives as a panel in any dock zone.
// Each instance gets its own CanvasStore for independent viewport/zoom/nodes.
// The first canvas created uses the default singleton store for compatibility.
// =============================================================================

import React, { useMemo, useCallback, useEffect } from 'react'
import { createCanvasStore, useCanvasStore as defaultCanvasStore, useNodeIds } from '../stores/canvasStore'
import { CanvasStoreProvider, useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import Canvas from '../canvas/Canvas'
import CanvasNode from '../canvas/CanvasNode'
import CanvasToolbar from '../canvas/CanvasToolbar'
import CanvasDropZone from '../docking/CanvasDropZone'
import Minimap from '../canvas/Minimap'
import { ShortcutHintOverlay } from '../ui/ShortcutHintOverlay'
import WelcomePage from '../ui/WelcomePage'
import type { PanelType, Point } from '../../shared/types'
import { useAppStore, useSelectedWorkspace, registerCanvasOps, unregisterCanvasOps, setActiveCanvasPanelId } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useStore } from 'zustand'
import { ensureWorkspaceFolder } from '../hooks/useShortcuts'
import { createCanvasOps } from '../lib/canvasBridge'

// Track which panel IDs have been assigned the default store
const defaultStoreAssigned = new Set<string>()
let firstCanvasId: string | null = null

interface CanvasPanelProps {
  panelId: string
  workspaceId: string
  nodeId: string
  /** Render function for panel content inside canvas nodes */
  renderPanelContent?: (panelId: string, nodeId: string, zoomLevel: number) => React.ReactNode
}

// ---------------------------------------------------------------------------
// CanvasNodeWrapper — reads its own node slice so re-renders stay local
// ---------------------------------------------------------------------------

const CanvasNodeWrapper = React.memo(({ nodeId, zoomLevel, renderPanelContent }: {
  nodeId: string
  zoomLevel: number
  renderPanelContent?: (panelId: string, nodeId: string, zoomLevel: number) => React.ReactNode
}) => {
  const node = useCanvasStoreContext((s) => s.nodes[nodeId])
  const isFocused = useCanvasStoreContext((s) => s.focusedNodeId === nodeId)
  const currentWorkspace = useSelectedWorkspace()

  if (!node) return null

  const panel = currentWorkspace?.panels[node.panelId]
  if (!panel) return null

  const hasStack = node.stackedPanelIds && node.stackedPanelIds.length > 1
  const activePanelId = hasStack
    ? node.stackedPanelIds![node.activeStackIndex || 0]
    : node.split ? node.split.panelIds[0] : node.panelId
  const secondaryPanelId = !hasStack && node.split ? node.split.panelIds[1] : undefined

  const activePanel = currentWorkspace?.panels[activePanelId] || panel

  return (
    <CanvasNode
      nodeId={node.id}
      panelId={activePanelId}
      panelType={activePanel.type}
      title={activePanel.title}
      isFocused={isFocused}
      zoomLevel={zoomLevel}
      splitContent={secondaryPanelId && renderPanelContent ? renderPanelContent(secondaryPanelId, node.id, zoomLevel) : undefined}
    >
      {renderPanelContent ? renderPanelContent(activePanelId, node.id, zoomLevel) : null}
    </CanvasNode>
  )
})

// ---------------------------------------------------------------------------
// CanvasPanel
// ---------------------------------------------------------------------------

export default function CanvasPanel({ panelId, workspaceId, nodeId, renderPanelContent }: CanvasPanelProps) {
  // First canvas panel uses the default singleton store for backward compatibility
  const store = useMemo(() => {
    if (firstCanvasId === null || firstCanvasId === panelId) {
      firstCanvasId = panelId
      defaultStoreAssigned.add(panelId)
      return defaultCanvasStore
    }
    return createCanvasStore()
  }, [panelId])

  // Register this canvas's operations so panel creation routes to the correct canvas
  useEffect(() => {
    const ops = createCanvasOps(store)
    registerCanvasOps(panelId, ops)
    // Set as active by default if it's the first canvas
    if (firstCanvasId === panelId) setActiveCanvasPanelId(panelId)
    return () => {
      unregisterCanvasOps(panelId)
      // Reset first canvas tracking so the next canvas panel
      // in this window claims the singleton store (preserving nodes)
      if (firstCanvasId === panelId) {
        firstCanvasId = null
        defaultStoreAssigned.delete(panelId)
      }
    }
  }, [panelId, store])

  const handlePointerDown = useCallback(() => {
    setActiveCanvasPanelId(panelId)
  }, [panelId])

  const zoomLevel = useStore(store, (s) => s.zoomLevel)
  const nodeIds = useNodeIds(store)
  const showMinimap = useSettingsStore((s) => s.showMinimap)

  const onCreateAtPoint = useCallback(
    (type: PanelType, canvasPoint: Point) => {
      if (type === 'canvas') {
        // Canvas panels don't go on canvases — create via appStore which routes to center zone
        useAppStore.getState().createCanvas(workspaceId)
        return
      }
      const appStore = useAppStore.getState()
      switch (type) {
        case 'terminal':
          appStore.createTerminal(workspaceId, undefined, canvasPoint)
          break
        case 'browser':
          appStore.createBrowser(workspaceId, undefined, canvasPoint)
          break
        case 'editor':
          appStore.createEditor(workspaceId, undefined, canvasPoint)
          break
        case 'git':
          appStore.createGit(workspaceId, canvasPoint)
          break
        case 'fileExplorer':
          appStore.createFileExplorer(workspaceId, canvasPoint)
          break
        case 'projectList':
          appStore.createProjectList(workspaceId, canvasPoint)
          break
      }
    },
    [workspaceId],
  )

  const onNewTerminal = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(workspaceId)
    if (wsId) useAppStore.getState().createTerminal(wsId)
  }, [workspaceId])

  const onNewBrowser = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(workspaceId)
    if (wsId) useAppStore.getState().createBrowser(wsId)
  }, [workspaceId])

  const onNewEditor = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(workspaceId)
    if (wsId) useAppStore.getState().createEditor(wsId)
  }, [workspaceId])

  const onZoomIn = useCallback(() => {
    store.getState().animateZoomTo(zoomLevel + 0.1)
  }, [zoomLevel, store])

  const onZoomOut = useCallback(() => {
    store.getState().animateZoomTo(zoomLevel - 0.1)
  }, [zoomLevel, store])

  return (
    <CanvasStoreProvider store={store}>
      <div className="relative w-full h-full" onPointerDown={handlePointerDown}>
        {/* Welcome page when canvas is empty */}
        {nodeIds.length === 0 && (
          <WelcomePage workspaceId={workspaceId} />
        )}

        <Canvas onCreateAtPoint={onCreateAtPoint}>
          {nodeIds.map((nId) => (
            <CanvasNodeWrapper
              key={nId}
              nodeId={nId}
              zoomLevel={zoomLevel}
              renderPanelContent={renderPanelContent}
            />
          ))}
        </Canvas>

        {showMinimap && <Minimap />}

        <CanvasDropZone canvasStoreApi={store} />

        <CanvasToolbar
          zoom={zoomLevel}
          onNewTerminal={onNewTerminal}
          onNewBrowser={onNewBrowser}
          onNewEditor={onNewEditor}
          onZoomIn={onZoomIn}
          onZoomOut={onZoomOut}
        />

        <ShortcutHintOverlay />
      </div>
    </CanvasStoreProvider>
  )
}
