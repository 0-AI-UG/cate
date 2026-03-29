// =============================================================================
// App — Main application component wiring all systems together.
// Ported from MainWindowView.swift
// =============================================================================

import React, { useEffect, useRef, useState, useCallback, Suspense } from 'react'
import { useAppStore } from './stores/appStore'
import { useCanvasStore, useNodeIds } from './stores/canvasStore'
import type { PanelType, Point } from '../shared/types'
import { useSettingsStore } from './stores/settingsStore'
import { useUIStore } from './stores/uiStore'
import { useShortcuts, ensureWorkspaceFolder } from './hooks/useShortcuts'
import { useProcessMonitor } from './hooks/useProcessMonitor'
import Canvas from './canvas/Canvas'
import CanvasNode from './canvas/CanvasNode'
import CanvasToolbar from './canvas/CanvasToolbar'
import Minimap from './canvas/Minimap'
import { Sidebar, RightSidebar } from './sidebar/Sidebar'
import { DockZone, DockDropIndicator } from './dock'
const TerminalPanel = React.lazy(() => import('./panels/TerminalPanel'))
const EditorPanel = React.lazy(() => import('./panels/EditorPanel'))
const BrowserPanel = React.lazy(() => import('./panels/BrowserPanel'))
const AIChatPanel = React.lazy(() => import('./panels/AIChatPanel'))
const GitPanel = React.lazy(() => import('./panels/GitPanel'))
const FileExplorerPanel = React.lazy(() => import('./panels/FileExplorerPanel'))
const ProjectListPanel = React.lazy(() => import('./panels/ProjectListPanel'))
import { NodeSwitcher } from './ui/NodeSwitcher'
import { PanelSwitcher } from './ui/PanelSwitcher'
import { CommandPalette } from './ui/CommandPalette'
import { GlobalSearch } from './ui/GlobalSearch'
import { ShortcutHintOverlay } from './ui/ShortcutHintOverlay'
import { SettingsWindow } from './settings/SettingsWindow'
import WelcomePage from './ui/WelcomePage'
import { AISetupDialog } from './dialogs/AISetupDialog'
import { loadSession, restoreSession, restoreMultiWorkspaceSession, setupAutoSave, saveSession } from './lib/session'
import type { MultiWorkspaceSession } from '../shared/types'

// -----------------------------------------------------------------------------
// CanvasNodeWrapper — reads its own node slice so re-renders stay local
// -----------------------------------------------------------------------------

const CanvasNodeWrapper = React.memo(({ nodeId, zoomLevel, renderPanelContent }: {
  nodeId: string
  zoomLevel: number
  renderPanelContent: (panelId: string, nodeId: string, zoomLevel: number) => React.ReactNode
}) => {
  const node = useCanvasStore((s) => s.nodes[nodeId])
  const isFocused = useCanvasStore((s) => s.focusedNodeId === nodeId)
  const currentWorkspace = useAppStore((s) => s.workspaces.find(w => w.id === s.selectedWorkspaceId))

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
      splitContent={secondaryPanelId ? renderPanelContent(secondaryPanelId, node.id, zoomLevel) : undefined}
    >
      {renderPanelContent(activePanelId, node.id, zoomLevel)}
    </CanvasNode>
  )
})

// -----------------------------------------------------------------------------
// App
// -----------------------------------------------------------------------------

export default function App() {
  const [showSettings, setShowSettings] = useState(false)
  const initializedRef = useRef(false)

  // Store state
  const workspaces = useAppStore((s) => s.workspaces)
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const nodeIds = useNodeIds()
  const zoomLevel = useCanvasStore((s) => s.zoomLevel)
  const sidebarVisible = useUIStore((s) => s.sidebarVisible)
  const showNodeSwitcher = useUIStore((s) => s.showNodeSwitcher)
  const showCommandPalette = useUIStore((s) => s.showCommandPalette)
  const showPanelSwitcher = useUIStore((s) => s.showPanelSwitcher)
  const showGlobalSearch = useUIStore((s) => s.showGlobalSearch)
  const showAISetupDialog = useUIStore((s) => s.showAISetupDialog)
  const showMinimap = useSettingsStore((s) => s.showMinimap)

  // Current workspace
  const currentWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId)

  // Global hooks
  useShortcuts()
  useProcessMonitor(selectedWorkspaceId)

  // ---------------------------------------------------------------------------
  // Initialization — load settings, create first terminal
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    const init = async () => {
      await useSettingsStore.getState().loadSettings()

      // Try to restore previous session
      const settings = useSettingsStore.getState()
      let restored = false
      if (settings.restoreSessionOnLaunch) {
        const session = await loadSession()
        if (session) {
          if ((session as MultiWorkspaceSession).version === 2) {
            await restoreMultiWorkspaceSession(session as MultiWorkspaceSession)
            restored = true
          } else {
            await restoreSession(session as any)
            restored = true
          }
        }
      }

      // Fallback: create a default workspace with a welcome terminal only if
      // no workspaces exist (fresh install or empty session).
      if (useAppStore.getState().workspaces.length === 0) {
        const wsId = useAppStore.getState().addWorkspace()
        useAppStore.getState().selectWorkspace(wsId)
      }

      // Start auto-save
      setupAutoSave()
    }
    init()
  }, [])

  // ---------------------------------------------------------------------------
  // Settings window (Cmd+, via native menu)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return window.electronAPI.onMenuOpenSettings(() => {
      setShowSettings((s) => !s)
    })
  }, [])

  // ---------------------------------------------------------------------------
  // Toolbar callbacks
  // ---------------------------------------------------------------------------
  const onNewTerminal = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(selectedWorkspaceId)
    if (wsId) useAppStore.getState().createTerminal(wsId)
  }, [selectedWorkspaceId])

  const onNewBrowser = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(selectedWorkspaceId)
    if (wsId) useAppStore.getState().createBrowser(wsId)
  }, [selectedWorkspaceId])

  const onNewEditor = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(selectedWorkspaceId)
    if (wsId) useAppStore.getState().createEditor(wsId)
  }, [selectedWorkspaceId])

  const onZoomIn = useCallback(() => {
    useCanvasStore.getState().animateZoomTo(zoomLevel + 0.1)
  }, [zoomLevel])

  const onZoomOut = useCallback(() => {
    useCanvasStore.getState().animateZoomTo(zoomLevel - 0.1)
  }, [zoomLevel])

  // ---------------------------------------------------------------------------
  // Drag-and-drop folder from Finder
  // ---------------------------------------------------------------------------
  const handleFileDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleFileDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    for (const file of files) {
      const filePath = (file as any).path as string | undefined
      if (!filePath) continue
      try {
        const stat = await window.electronAPI.fsStat(filePath)
        if (stat.isDirectory) {
          useAppStore.getState().setWorkspaceRootPath(selectedWorkspaceId, filePath)
          break
        }
      } catch { /* ignore */ }
    }
  }, [selectedWorkspaceId])

  /** Called when the user right-clicks empty canvas and picks a panel type. */
  const onCreateAtPoint = useCallback(
    (type: PanelType, canvasPoint: Point) => {
      const store = useAppStore.getState()
      switch (type) {
        case 'terminal':
          store.createTerminal(selectedWorkspaceId, undefined, canvasPoint)
          break
        case 'browser':
          store.createBrowser(selectedWorkspaceId, undefined, canvasPoint)
          break
        case 'editor':
          store.createEditor(selectedWorkspaceId, undefined, canvasPoint)
          break
        case 'aiChat':
          store.createAIChat(selectedWorkspaceId, canvasPoint)
          break
        case 'git':
          store.createGit(selectedWorkspaceId, canvasPoint)
          break
        case 'fileExplorer':
          store.createFileExplorer(selectedWorkspaceId, canvasPoint)
          break
        case 'projectList':
          store.createProjectList(selectedWorkspaceId, canvasPoint)
          break
      }
    },
    [selectedWorkspaceId],
  )

  // ---------------------------------------------------------------------------
  // Render panel content for a node
  // ---------------------------------------------------------------------------
  const renderPanelContent = useCallback(
    (panelId: string, nodeId: string, zoom: number) => {
      if (!currentWorkspace) return null
      const panel = currentWorkspace.panels[panelId]
      if (!panel) return null

      let content: React.ReactNode = null
      switch (panel.type) {
        case 'terminal':
          content = (
            <TerminalPanel
              panelId={panelId}
              workspaceId={selectedWorkspaceId}
              nodeId={nodeId}
            />
          )
          break
        case 'editor':
          content = (
            <EditorPanel
              panelId={panelId}
              workspaceId={selectedWorkspaceId}
              nodeId={nodeId}
              filePath={panel.filePath}
            />
          )
          break
        case 'browser':
          content = (
            <BrowserPanel
              panelId={panelId}
              workspaceId={selectedWorkspaceId}
              nodeId={nodeId}
              url={panel.url}
              zoomLevel={zoom}
            />
          )
          break
        case 'aiChat':
          content = (
            <AIChatPanel
              panelId={panelId}
              workspaceId={selectedWorkspaceId}
              nodeId={nodeId}
            />
          )
          break
        case 'git':
          content = (
            <GitPanel
              panelId={panelId}
              workspaceId={selectedWorkspaceId}
              nodeId={nodeId}
            />
          )
          break
        case 'fileExplorer':
          content = (
            <FileExplorerPanel
              panelId={panelId}
              workspaceId={selectedWorkspaceId}
              nodeId={nodeId}
            />
          )
          break
        case 'projectList':
          content = (
            <ProjectListPanel
              panelId={panelId}
              workspaceId={selectedWorkspaceId}
              nodeId={nodeId}
            />
          )
          break
        default:
          return null
      }

      return (
        <Suspense fallback={<div className="w-full h-full bg-[#1e1e1e] flex items-center justify-center text-zinc-500 text-sm">Loading...</div>}>
          {content}
        </Suspense>
      )
    },
    [currentWorkspace, selectedWorkspaceId],
  )

  return (
    <div className="h-screen w-screen flex bg-canvas-bg" onDragOver={handleFileDragOver} onDrop={handleFileDrop}>
      {/* Sidebar */}
      <Sidebar isVisible={sidebarVisible} />

      {/* Canvas workspace area with dock zones */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 flex overflow-hidden">
          <DockZone position="left" renderPanelContent={renderPanelContent} />

          <div className="flex-1 relative overflow-hidden">
            {/* Welcome page overlay when no panels exist */}
            {nodeIds.length === 0 && (
              <WelcomePage workspaceId={selectedWorkspaceId} />
            )}

            <Canvas onCreateAtPoint={onCreateAtPoint}>
              {nodeIds.map((nodeId) => (
                <CanvasNodeWrapper
                  key={nodeId}
                  nodeId={nodeId}
                  zoomLevel={zoomLevel}
                  renderPanelContent={renderPanelContent}
                />
              ))}
            </Canvas>

            {/* Minimap overlay */}
            {showMinimap && <Minimap />}

            {/* Toolbar overlay */}
            <CanvasToolbar
              zoom={zoomLevel}
              onNewTerminal={onNewTerminal}
              onNewBrowser={onNewBrowser}
              onNewEditor={onNewEditor}
              onZoomIn={onZoomIn}
              onZoomOut={onZoomOut}
            />

            {/* Shortcut hint overlay */}
            <ShortcutHintOverlay />
          </div>

          <DockZone position="right" renderPanelContent={renderPanelContent} />
        </div>
        <DockZone position="bottom" renderPanelContent={renderPanelContent} />
      </div>

      {/* Right Sidebar */}
      <RightSidebar />

      <DockDropIndicator />

      {/* Modal overlays */}
      {showNodeSwitcher && <NodeSwitcher />}
      {showPanelSwitcher && <PanelSwitcher />}
      {showCommandPalette && <CommandPalette />}
      {showGlobalSearch && <GlobalSearch />}
      {showSettings && (
        <SettingsWindow isOpen={showSettings} onClose={() => setShowSettings(false)} />
      )}
      {showAISetupDialog && (
        <AISetupDialog workspaceId={selectedWorkspaceId} />
      )}
    </div>
  )
}
