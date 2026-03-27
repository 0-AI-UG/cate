// =============================================================================
// App — Main application component wiring all systems together.
// Ported from MainWindowView.swift
// =============================================================================

import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from './stores/appStore'
import { useCanvasStore } from './stores/canvasStore'
import type { PanelType, Point } from '../shared/types'
import { useSettingsStore } from './stores/settingsStore'
import { useStatusStore } from './stores/statusStore'
import { useUIStore } from './stores/uiStore'
import { useShortcuts } from './hooks/useShortcuts'
import { useProcessMonitor } from './hooks/useProcessMonitor'
import Canvas from './canvas/Canvas'
import CanvasNode from './canvas/CanvasNode'
import CanvasToolbar from './canvas/CanvasToolbar'
import { Sidebar } from './sidebar/Sidebar'
import TerminalPanel from './panels/TerminalPanel'
import EditorPanel from './panels/EditorPanel'
import BrowserPanel from './panels/BrowserPanel'
import { NodeSwitcher } from './ui/NodeSwitcher'
import { CommandPalette } from './ui/CommandPalette'
import { ShortcutHintOverlay } from './ui/ShortcutHintOverlay'
import { SettingsWindow } from './settings/SettingsWindow'
import { generateWelcomeBanner } from './ui/WelcomeBanner'
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

      // Fallback: create default terminal with welcome banner
      if (!restored) {
        const wsId = useAppStore.getState().selectedWorkspaceId
        const panels = useAppStore.getState().selectedWorkspace()?.panels ?? {}
        if (Object.keys(panels).length === 0) {
          useAppStore.getState().createTerminal(wsId, generateWelcomeBanner())
        }
      }

      // Start auto-save
      setupAutoSave()
    }
    init()
  }, [initialized])

  // ---------------------------------------------------------------------------
  // Settings window (Cmd+,)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        setShowSettings((s) => !s)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
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

  const onZoomIn = useCallback(() => {
    useCanvasStore.getState().zoomAroundCenter(zoomLevel + 0.1)
  }, [zoomLevel])

  const onZoomOut = useCallback(() => {
    useCanvasStore.getState().zoomAroundCenter(zoomLevel - 0.1)
  }, [zoomLevel])

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

      switch (panel.type) {
        case 'terminal':
          return (
            <TerminalPanel
              panelId={panelId}
              workspaceId={selectedWorkspaceId}
              nodeId={nodeId}
            />
          )
        case 'editor':
          return (
            <EditorPanel
              panelId={panelId}
              workspaceId={selectedWorkspaceId}
              nodeId={nodeId}
              filePath={panel.filePath}
            />
          )
        case 'browser':
          return (
            <BrowserPanel
              panelId={panelId}
              workspaceId={selectedWorkspaceId}
              nodeId={nodeId}
              url={panel.url}
            />
          )
        default:
          return null
      }
    },
    [currentWorkspace, selectedWorkspaceId],
  )

  // ---------------------------------------------------------------------------
  // Sorted nodes for rendering
  // ---------------------------------------------------------------------------
  const sortedNodes = Object.values(nodes).sort((a, b) => a.zOrder - b.zOrder)

  return (
    <div className="h-screen w-screen flex bg-canvas-bg">
      {/* Sidebar */}
      <Sidebar isVisible={sidebarVisible} />

      {/* Canvas workspace area */}
      <div className="flex-1 relative overflow-hidden">
        <Canvas onCreateAtPoint={onCreateAtPoint}>
          {sortedNodes.map((node) => {
            const panel = currentWorkspace?.panels[node.panelId]
            if (!panel) return null

            const wsStatus = useStatusStore.getState().workspaces[selectedWorkspaceId]
            const nodeActivity = wsStatus?.nodeActivity[node.id] ?? { type: 'normal' as const }

            return (
              <CanvasNode
                key={node.id}
                nodeId={node.id}
                panelId={node.panelId}
                panelType={panel.type}
                title={panel.title}
                isFocused={focusedNodeId === node.id}
                activityState={nodeActivity}
                zoomLevel={zoomLevel}
              >
                {renderPanelContent(node.panelId, node.id)}
              </CanvasNode>
            )
          })}
        </Canvas>

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

      {/* Modal overlays */}
      {showNodeSwitcher && <NodeSwitcher />}
      {showCommandPalette && <CommandPalette />}
      {showSettings && (
        <SettingsWindow isOpen={showSettings} onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}
