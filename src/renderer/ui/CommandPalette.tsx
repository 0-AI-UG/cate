// =============================================================================
// CommandPalette — Searchable command launcher overlay.
// Ported from commandPaletteItems in MainWindowView.swift
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Terminal,
  Globe,
  FileText,
  SquaresFour,
  Sidebar,
  FolderOpen,
  Stack,
  MagnifyingGlass,
  ArrowsOutSimple,
  Square,
  FloppyDisk,
  Download,
  Upload,
} from '@phosphor-icons/react'
import { useUIStore } from '../stores/uiStore'
import { useAppStore } from '../stores/appStore'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'

// -----------------------------------------------------------------------------
// Command definitions
// -----------------------------------------------------------------------------

interface CommandItem {
  id: string
  title: string
  shortcutText: string
  icon: React.ReactNode
  action: () => void
}

// Local icon aliases — small wrappers so JSX call sites stay unchanged.
const ICON_SIZE = 16
const TerminalIcon = () => <Terminal size={ICON_SIZE} />
const GlobeIcon = () => <Globe size={ICON_SIZE} />
const FileTextIcon = () => <FileText size={ICON_SIZE} />
const LayoutIcon = () => <SquaresFour size={ICON_SIZE} />
const SidebarIcon = () => <Sidebar size={ICON_SIZE} />
const FolderOpenIcon = () => <FolderOpen size={ICON_SIZE} />
const LayersIcon = () => <Stack size={ICON_SIZE} />
const ZoomResetIcon = () => <MagnifyingGlass size={ICON_SIZE} />
const ZoomToFitIcon = () => <ArrowsOutSimple size={ICON_SIZE} />
const RectangleIcon = () => <Square size={ICON_SIZE} />
const SaveIcon = () => <FloppyDisk size={ICON_SIZE} />
const DownloadIcon = () => <Download size={ICON_SIZE} />
const UploadIcon = () => <Upload size={ICON_SIZE} />

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export const CommandPalette: React.FC = () => {
  const showCommandPalette = useUIStore((s) => s.showCommandPalette)
  const setShowCommandPalette = useUIStore((s) => s.setShowCommandPalette)
  const setShowNodeSwitcher = useUIStore((s) => s.setShowNodeSwitcher)
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const createTerminal = useAppStore((s) => s.createTerminal)
  const createBrowser = useAppStore((s) => s.createBrowser)
  const createEditor = useAppStore((s) => s.createEditor)
  const createCanvas = useAppStore((s) => s.createCanvas)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const setActiveRightSidebarView = useUIStore((s) => s.setActiveRightSidebarView)
  const canvasApi = useCanvasStoreApi()
  const setZoom = useCanvasStoreContext((s) => s.setZoom)

  const rootPath = useAppStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
    return ws?.rootPath
  })
  const [files, setFiles] = useState<string[]>([])

  useEffect(() => {
    if (!rootPath) { setFiles([]); return }
    window.electronAPI.gitLsFiles(rootPath)
      .then((result) => setFiles(result))
      .catch(() => setFiles([]))
  }, [rootPath])

  const [searchText, setSearchText] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const close = useCallback(() => {
    setShowCommandPalette(false)
    setSearchText('')
    setSelectedIndex(0)
  }, [setShowCommandPalette])

  const dockCenter = { target: 'dock', zone: 'center' } as const

  // Build command items
  const allCommands: CommandItem[] = useMemo(
    () => [
      {
        id: 'newTerminal',
        title: 'New Terminal',
        shortcutText: '\u2318T',
        icon: <TerminalIcon />,
        action: () => createTerminal(selectedWorkspaceId, undefined, undefined, dockCenter),
      },
      {
        id: 'newBrowser',
        title: 'New Browser',
        shortcutText: '\u2318\u21E7B',
        icon: <GlobeIcon />,
        action: () => createBrowser(selectedWorkspaceId, undefined, undefined, dockCenter),
      },
      {
        id: 'newEditor',
        title: 'New Editor',
        shortcutText: '\u2318\u21E7E',
        icon: <FileTextIcon />,
        action: () => createEditor(selectedWorkspaceId, undefined, undefined, dockCenter),
      },
      {
        id: 'newCanvas',
        title: 'New Canvas',
        shortcutText: '',
        icon: <LayoutIcon />,
        action: () => createCanvas(selectedWorkspaceId),
      },
      {
        id: 'toggleSidebar',
        title: 'Toggle Sidebar',
        shortcutText: '\u2318\\',
        icon: <SidebarIcon />,
        action: () => toggleSidebar(),
      },
      {
        id: 'toggleFileExplorer',
        title: 'Toggle File Explorer',
        shortcutText: '\u2318\u21E7F',
        icon: <FolderOpenIcon />,
        action: () => { setActiveRightSidebarView('explorer') },
      },
      {
        id: 'nodeSwitcher',
        title: 'Switch Panel',
        shortcutText: '\u2303Space',
        icon: <LayersIcon />,
        action: () => setShowNodeSwitcher(true),
      },
      {
        id: 'zoomReset',
        title: 'Reset Zoom',
        shortcutText: '\u23180',
        icon: <ZoomResetIcon />,
        action: () => setZoom(1.0),
      },
      {
        id: 'zoomToFit',
        title: 'Zoom to Fit',
        shortcutText: '\u23181',
        icon: <ZoomToFitIcon />,
        action: () => canvasApi.getState().zoomToFit(),
      },
      {
        id: 'autoLayout',
        title: 'Auto-Layout Panels',
        shortcutText: '',
        icon: <LayersIcon />,
        action: () => canvasApi.getState().autoLayout(),
      },
      {
        id: 'newRegion',
        title: 'New Region',
        shortcutText: '',
        icon: <RectangleIcon />,
        action: () => canvasApi.getState().addRegion('Region', { x: 200, y: 200 }, { width: 400, height: 300 }),
      },
      {
        id: 'saveLayout',
        title: 'Save Layout As...',
        shortcutText: '',
        icon: <SaveIcon />,
        action: async () => {
          const name = window.prompt('Layout name:')
          if (!name?.trim()) return
          const state = canvasApi.getState()
          const appState = useAppStore.getState()
          const workspace = appState.workspaces.find((w) => w.id === appState.selectedWorkspaceId)
          const snapshot = {
            nodes: Object.values(state.nodes).map((n) => {
              const panel = workspace?.panels[n.panelId]
              return { panelType: panel?.type ?? 'terminal', origin: n.origin, size: n.size }
            }),
            regions: Object.values(state.regions).map((r) => ({
              origin: r.origin, size: r.size, label: r.label, color: r.color,
            })),
          }
          await window.electronAPI.layoutSave(name.trim(), snapshot)
        },
      },
      {
        id: 'loadLayout',
        title: 'Load Layout...',
        shortcutText: '',
        icon: <DownloadIcon />,
        action: async () => {
          const names = await window.electronAPI.layoutList()
          if (names.length === 0) { alert('No saved layouts'); return }
          const name = window.prompt('Available layouts:\n' + names.join('\n') + '\n\nEnter name:')
          if (!name?.trim()) return
          const snapshot = await window.electronAPI.layoutLoad(name.trim()) as any
          if (!snapshot) { alert('Layout not found'); return }
          const wsId = useAppStore.getState().selectedWorkspaceId
          useAppStore.getState().closeAllPanels(wsId)
          for (const node of snapshot.nodes || []) {
            switch (node.panelType) {
              case 'terminal': useAppStore.getState().createTerminal(wsId, undefined, node.origin); break
              case 'editor': useAppStore.getState().createEditor(wsId, undefined, node.origin); break
              case 'browser': useAppStore.getState().createBrowser(wsId, undefined, node.origin); break
            }
          }
          for (const region of snapshot.regions || []) {
            canvasApi.getState().addRegion(region.label, region.origin, region.size, region.color)
          }
          canvasApi.getState().zoomToFit()
        },
      },
      {
        id: 'exportWorkspace',
        title: 'Export Workspace Layout',
        shortcutText: '',
        icon: <UploadIcon />,
        action: async () => {
          const state = canvasApi.getState()
          const appState = useAppStore.getState()
          const workspace = appState.workspaces.find((w) => w.id === appState.selectedWorkspaceId)
          if (!workspace) return

          const exportData = {
            version: 1,
            name: workspace.name,
            nodes: Object.values(state.nodes).map((n) => {
              const panel = workspace.panels[n.panelId]
              return {
                panelType: panel?.type || 'terminal',
                title: panel?.title || 'Panel',
                origin: n.origin,
                size: n.size,
                filePath: panel?.filePath,
                url: panel?.url,
              }
            }),
            regions: Object.values(state.regions).map((r) => ({
              origin: r.origin, size: r.size, label: r.label, color: r.color,
            })),
            zoomLevel: state.zoomLevel,
            viewportOffset: state.viewportOffset,
          }

          const filePath = await window.electronAPI.saveFileDialog({
            defaultPath: `${workspace.name}-layout.json`,
            filters: [{ name: 'Workspace Layout', extensions: ['json'] }],
          })
          if (filePath) {
            await window.electronAPI.fsWriteFile(filePath, JSON.stringify(exportData, null, 2))
          }
        },
      },
      {
        id: 'importWorkspace',
        title: 'Import Workspace Layout',
        shortcutText: '',
        icon: <DownloadIcon />,
        action: async () => {
          const filePath = window.prompt('Enter path to layout JSON file:')
          if (!filePath?.trim()) return

          try {
            const content = await window.electronAPI.fsReadFile(filePath.trim())
            const data = JSON.parse(content) as any
            if (!data.version || !data.nodes) {
              alert('Invalid layout file')
              return
            }

            const wsId = useAppStore.getState().selectedWorkspaceId
            useAppStore.getState().closeAllPanels(wsId)

            for (const node of data.nodes) {
              switch (node.panelType) {
                case 'terminal': useAppStore.getState().createTerminal(wsId, undefined, node.origin); break
                case 'editor': useAppStore.getState().createEditor(wsId, node.filePath, node.origin); break
                case 'browser': useAppStore.getState().createBrowser(wsId, node.url, node.origin); break

              }
            }

            for (const region of data.regions || []) {
              canvasApi.getState().addRegion(region.label, region.origin, region.size, region.color)
            }

            if (data.zoomLevel) canvasApi.getState().setZoom(data.zoomLevel)
            if (data.viewportOffset) canvasApi.getState().setViewportOffset(data.viewportOffset)
          } catch {
            alert('Failed to load layout file')
          }
        },
      },
    ],
    [
      selectedWorkspaceId,
      createTerminal,
      createBrowser,
      createEditor,
      createCanvas,
      toggleSidebar,
      setActiveRightSidebarView,
      setShowNodeSwitcher,
      setZoom,
    ],
  )

  // Filter by search text
  const filteredCommands = useMemo(() => {
    if (!searchText.trim()) return allCommands
    const lower = searchText.toLowerCase()
    return allCommands.filter((cmd) => cmd.title.toLowerCase().includes(lower))
  }, [allCommands, searchText])

  // Matching files from git-tracked list
  const matchingFiles = useMemo(() => {
    if (searchText.length <= 1) return []
    const lower = searchText.toLowerCase()
    return files
      .filter((f) => {
        const name = f.split('/').pop() || f
        return name.toLowerCase().includes(lower)
      })
      .slice(0, 10)
  }, [files, searchText])

  const totalItems = filteredCommands.length + matchingFiles.length

  // Clamp selection when filtered list changes
  useEffect(() => {
    setSelectedIndex((prev) =>
      prev >= totalItems ? Math.max(0, totalItems - 1) : prev,
    )
  }, [totalItems])

  // Focus input when shown
  useEffect(() => {
    if (showCommandPalette) {
      setSearchText('')
      setSelectedIndex(0)
      // Small delay to ensure DOM is mounted
      requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
    }
  }, [showCommandPalette])

  const executeCommand = useCallback(
    (cmd: CommandItem) => {
      close()
      cmd.action()
    },
    [close],
  )

  // Keyboard navigation
  useEffect(() => {
    if (!showCommandPalette) return

    function handleKey(e: KeyboardEvent) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) =>
            totalItems === 0 ? 0 : (prev + 1) % totalItems,
          )
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) =>
            totalItems === 0 ? 0 : (prev - 1 + totalItems) % totalItems,
          )
          break
        case 'Enter':
          e.preventDefault()
          if (selectedIndex < filteredCommands.length) {
            if (filteredCommands[selectedIndex]) {
              executeCommand(filteredCommands[selectedIndex])
            }
          } else {
            const fileIndex = selectedIndex - filteredCommands.length
            const file = matchingFiles[fileIndex]
            if (file) {
              const wsId = useAppStore.getState().selectedWorkspaceId
              const fullPath = rootPath ? `${rootPath}/${file}` : file
              useAppStore.getState().createEditor(wsId, fullPath, undefined, dockCenter)
              close()
            }
          }
          break
        case 'Escape':
          e.preventDefault()
          close()
          break
      }
    }

    document.addEventListener('keydown', handleKey, { capture: true })
    return () =>
      document.removeEventListener('keydown', handleKey, { capture: true })
  }, [showCommandPalette, filteredCommands, matchingFiles, selectedIndex, totalItems, rootPath, executeCommand, close])

  if (!showCommandPalette) return null

  return (
    <div
      className="fixed inset-0 bg-black/20 flex items-start justify-center pt-[20vh] z-50"
      onClick={close}
    >
      <div
        className="w-96 bg-surface-5 rounded-xl border border-subtle shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="px-3 py-2">
          <input
            ref={inputRef}
            type="text"
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value)
              setSelectedIndex(0)
            }}
            placeholder="Type a command..."
            className="w-full h-10 bg-transparent text-sm text-primary placeholder:text-muted outline-none"
          />
        </div>

        {/* Divider */}
        <div className="border-b border-subtle" />

        {/* Commands list */}
        <div className="max-h-[300px] overflow-y-auto py-1">
          {filteredCommands.length === 0 && matchingFiles.length === 0 ? (
            <div className="text-muted text-sm text-center py-4">
              No matching commands
            </div>
          ) : (
            <>
              {filteredCommands.map((cmd, index) => (
                <div
                  key={cmd.id}
                  className={`flex items-center px-3 py-2 gap-3 cursor-pointer transition-colors ${
                    index === selectedIndex
                      ? 'bg-surface-6'
                      : 'hover:bg-hover'
                  }`}
                  onClick={() => executeCommand(cmd)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <span className="text-secondary flex-shrink-0">{cmd.icon}</span>
                  <span className="text-sm text-primary flex-1">{cmd.title}</span>
                  <span className="text-xs text-muted flex-shrink-0">
                    {cmd.shortcutText}
                  </span>
                </div>
              ))}
              {matchingFiles.length > 0 && (
                <>
                  <div className="px-3 py-1 text-xs text-muted uppercase tracking-wider">
                    Files
                  </div>
                  {matchingFiles.map((file, i) => {
                    const fileIndex = filteredCommands.length + i
                    return (
                      <div
                        key={file}
                        className={`flex items-center px-3 py-2 gap-3 cursor-pointer transition-colors ${
                          fileIndex === selectedIndex
                            ? 'bg-surface-6'
                            : 'hover:bg-hover'
                        }`}
                        onClick={() => {
                          const wsId = useAppStore.getState().selectedWorkspaceId
                          const fullPath = rootPath ? `${rootPath}/${file}` : file
                          useAppStore.getState().createEditor(wsId, fullPath, undefined, dockCenter)
                          close()
                        }}
                        onMouseEnter={() => setSelectedIndex(fileIndex)}
                      >
                        <span className="text-secondary flex-shrink-0">
                          <FileTextIcon />
                        </span>
                        <span className="text-sm text-primary flex-1 truncate">{file}</span>
                      </div>
                    )
                  })}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
