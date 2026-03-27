// =============================================================================
// App — Main application component wiring all systems together.
// Ported from MainWindowView.swift
// =============================================================================

import React, { useEffect, useState, useCallback, Suspense } from 'react'
import { useAppStore } from './stores/appStore'
import { useCanvasStore } from './stores/canvasStore'
import type { PanelType, Point } from '../shared/types'
import { useSettingsStore } from './stores/settingsStore'
import { useUIStore } from './stores/uiStore'
import { useShortcuts } from './hooks/useShortcuts'
import { useProcessMonitor } from './hooks/useProcessMonitor'
import Canvas from './canvas/Canvas'
import CanvasNode from './canvas/CanvasNode'
import CanvasToolbar from './canvas/CanvasToolbar'
import Minimap from './canvas/Minimap'
import { Sidebar } from './sidebar/Sidebar'
import { FileExplorerSidebar } from './sidebar/FileExplorerSidebar'
const TerminalPanel = React.lazy(() => import('./panels/TerminalPanel'))
const EditorPanel = React.lazy(() => import('./panels/EditorPanel'))
const BrowserPanel = React.lazy(() => import('./panels/BrowserPanel'))
const AIChatPanel = React.lazy(() => import('./panels/AIChatPanel'))
const GitPanel = React.lazy(() => import('./panels/GitPanel'))
import { NodeSwitcher } from './ui/NodeSwitcher'
import { PanelSwitcher } from './ui/PanelSwitcher'
import { CommandPalette } from './ui/CommandPalette'
import { GlobalSearch } from './ui/GlobalSearch'
import { ShortcutHintOverlay } from './ui/ShortcutHintOverlay'
import { SettingsWindow } from './settings/SettingsWindow'
import WelcomePage from './ui/WelcomePage'
import { loadSession, restoreSession, restoreMultiWorkspaceSession, setupAutoSave, saveSession } from './lib/session'
import type { MultiWorkspaceSession } from '../shared/types'

// -----------------------------------------------------------------------------
// App
// -----------------------------------------------------------------------------

export default function App() {
  const [showSettings, setShowSettings] = useState(false)
  const [initialized, setInitialized] = useState(false)

  // Store state
  const workspaces = useAppStore((s) => s.workspaces)
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const nodes = useCanvasStore((s) => s.nodes)
  const zoomLevel = useCanvasStore((s) => s.zoomLevel)
  const focusedNodeId = useCanvasStore((s) => s.focusedNodeId)
  const sidebarVisible = useUIStore((s) => s.sidebarVisible)
  const showNodeSwitcher = useUIStore((s) => s.showNodeSwitcher)
  const showCommandPalette = useUIStore((s) => s.showCommandPalette)
  const showPanelSwitcher = useUIStore((s) => s.showPanelSwitcher)
  const showGlobalSearch = useUIStore((s) => s.showGlobalSearch)
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
    if (initialized) return
    setInitialized(true)

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
  }, [initialized])

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
  const onNewTerminal = useCallback(() => {
    useAppStore.getState().createTerminal(selectedWorkspaceId)
  }, [selectedWorkspaceId])

  const onNewBrowser = useCallback(() => {
    useAppStore.getState().createBrowser(selectedWorkspaceId)
  }, [selectedWorkspaceId])

  const onNewEditor = useCallback(() => {
    useAppStore.getState().createEditor(selectedWorkspaceId)
  }, [selectedWorkspaceId])

  const onNewAIChat = useCallback(() => {
    useAppStore.getState().createAIChat(selectedWorkspaceId)
  }, [selectedWorkspaceId])

  const onNewGit = useCallback(() => {
    useAppStore.getState().createGit(selectedWorkspaceId)
  }, [selectedWorkspaceId])

  const onZoomIn = useCallback(() => {
    useCanvasStore.getState().zoomAroundCenter(zoomLevel + 0.1)
  }, [zoomLevel])

  const onZoomOut = useCallback(() => {
    useCanvasStore.getState().zoomAroundCenter(zoomLevel - 0.1)
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
      }
    },
    [selectedWorkspaceId],
  )

  // ---------------------------------------------------------------------------
  // Render panel content for a node
  // ---------------------------------------------------------------------------
  const renderPanelContent = useCallback(
    (panelId: string, nodeId: string) => {
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

  // ---------------------------------------------------------------------------
  // Sorted nodes for rendering
  // ---------------------------------------------------------------------------
  const sortedNodes = Object.values(nodes).sort((a, b) => a.zOrder - b.zOrder)

  return (
    <div className="h-screen w-screen flex bg-canvas-bg" onDragOver={handleFileDragOver} onDrop={handleFileDrop}>
      {/* Sidebar */}
      <Sidebar isVisible={sidebarVisible} />

      {/* File Explorer — separate collapsible sidebar */}
      <FileExplorerSidebar />

      {/* Canvas workspace area */}
      <div className="flex-1 relative overflow-hidden">
        {/* Welcome page overlay when no panels exist */}
        {Object.keys(nodes).length === 0 && (
          <WelcomePage workspaceId={selectedWorkspaceId} />
        )}

        <Canvas onCreateAtPoint={onCreateAtPoint}>
          {sortedNodes.map((node) => {
            const panel = currentWorkspace?.panels[node.panelId]
            if (!panel) return null

            // For stacked nodes, show the active tab's panel.
            // For split nodes, render the primary panel as children and the
            // secondary panel as splitContent.
            const hasStack = node.stackedPanelIds && node.stackedPanelIds.length > 1
            const activePanelId = hasStack
              ? node.stackedPanelIds![node.activeStackIndex || 0]
              : node.split ? node.split.panelIds[0] : node.panelId
            const secondaryPanelId = !hasStack && node.split ? node.split.panelIds[1] : undefined

            // Resolve the panel for title/type using the active panel
            const activePanel = currentWorkspace?.panels[activePanelId] || panel

            return (
              <CanvasNode
                key={node.id}
                nodeId={node.id}
                panelId={activePanelId}
                panelType={activePanel.type}
                title={activePanel.title}
                isFocused={focusedNodeId === node.id}
                zoomLevel={zoomLevel}
                splitContent={secondaryPanelId ? renderPanelContent(secondaryPanelId, node.id) : undefined}
              >
                {renderPanelContent(activePanelId, node.id)}
              </CanvasNode>
            )
          })}
        </Canvas>

        {/* Minimap overlay */}
        {showMinimap && <Minimap />}

        {/* Toolbar overlay */}
        <CanvasToolbar
          zoom={zoomLevel}
          onNewTerminal={onNewTerminal}
          onNewBrowser={onNewBrowser}
          onNewEditor={onNewEditor}
          onNewAIChat={onNewAIChat}
          onNewGit={onNewGit}
          onZoomIn={onZoomIn}
          onZoomOut={onZoomOut}
        />

        {/* Shortcut hint overlay */}
        <ShortcutHintOverlay />
      </div>

      {/* Modal overlays */}
      {showNodeSwitcher && <NodeSwitcher />}
      {showPanelSwitcher && <PanelSwitcher />}
      {showCommandPalette && <CommandPalette />}
      {showGlobalSearch && <GlobalSearch />}
      {showSettings && (
        <SettingsWindow isOpen={showSettings} onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}
