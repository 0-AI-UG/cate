// =============================================================================
// CommandPalette — Searchable command launcher overlay.
// Ported from commandPaletteItems in MainWindowView.swift
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/shallow'
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
  Sparkle,
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
const AgentIcon = () => <Sparkle size={ICON_SIZE} />

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
  const createAgent = useAppStore((s) => s.createAgent)
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
        id: 'newAgent',
        title: 'New Pi Agent',
        shortcutText: '',
        icon: <AgentIcon />,
        action: () => createAgent(selectedWorkspaceId, undefined, dockCenter),
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
        shortcutText: '\u2318\u21E7X',
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
        title: 'Auto-Layout Canvas',
        shortcutText: '\u21E7\u2318L',
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
        id: 'manageLayouts',
        title: 'Saved Layouts…',
        shortcutText: '',
        icon: <SaveIcon />,
        action: () => useUIStore.getState().setShowLayoutsDialog(true),
      },
    ],
    [
      selectedWorkspaceId,
      createTerminal,
      createBrowser,
      createEditor,
      createCanvas,
      createAgent,
      toggleSidebar,
      setActiveRightSidebarView,
      setShowNodeSwitcher,
      setZoom,
    ],
  )

  // Open panels in the current workspace (for recommended items)
  const openPanels = useAppStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
    if (!ws) return []
    return Object.values(ws.panels)
  }))

  // Recently-used / recommended files (show top 5 from git when no search)
  const recommendedFiles = useMemo(() => files.slice(0, 5), [files])

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

  // When no search text, show open panels and recommended files
  const showRecommended = !searchText.trim()
  const recommendedPanels = useMemo(() => {
    if (!showRecommended) return []
    return openPanels.filter((p) => p.type === 'terminal' || p.type === 'editor' || p.type === 'browser' || p.type === 'agent')
  }, [openPanels, showRecommended])

  const totalItems = showRecommended
    ? recommendedPanels.length + recommendedFiles.length + filteredCommands.length
    : filteredCommands.length + matchingFiles.length

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
          if (showRecommended) {
            // Order: panels → files → commands
            if (selectedIndex < recommendedPanels.length) {
              const panel = recommendedPanels[selectedIndex]
              if (panel) {
                const cs = canvasApi.getState()
                const nodeEntry = Object.values(cs.nodes).find((n) => n.panelId === panel.id)
                if (nodeEntry) cs.focusNode(nodeEntry.id)
                close()
              }
            } else if (selectedIndex < recommendedPanels.length + recommendedFiles.length) {
              const file = recommendedFiles[selectedIndex - recommendedPanels.length]
              if (file) {
                const wsId = useAppStore.getState().selectedWorkspaceId
                const fullPath = rootPath ? `${rootPath}/${file}` : file
                useAppStore.getState().createEditor(wsId, fullPath, undefined, dockCenter)
                close()
              }
            } else {
              const cmdIndex = selectedIndex - recommendedPanels.length - recommendedFiles.length
              const cmd = filteredCommands[cmdIndex]
              if (cmd) executeCommand(cmd)
            }
          } else {
            // Order: commands → files
            if (selectedIndex < filteredCommands.length) {
              const cmd = filteredCommands[selectedIndex]
              if (cmd) executeCommand(cmd)
            } else {
              const file = matchingFiles[selectedIndex - filteredCommands.length]
              if (file) {
                const wsId = useAppStore.getState().selectedWorkspaceId
                const fullPath = rootPath ? `${rootPath}/${file}` : file
                useAppStore.getState().createEditor(wsId, fullPath, undefined, dockCenter)
                close()
              }
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
  }, [showCommandPalette, filteredCommands, matchingFiles, recommendedPanels, recommendedFiles, showRecommended, selectedIndex, totalItems, rootPath, executeCommand, close, canvasApi])

  if (!showCommandPalette) return null

  return (
    <div
      className="fixed inset-0 bg-black/40 flex justify-center z-50"
      onClick={close}
    >
      <div
        className="w-[640px] max-w-[640px] max-h-[560px] mt-[160px] rounded-3xl overflow-hidden flex flex-col self-start bg-surface-4/85 backdrop-blur-2xl border border-white/20 shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input — matches the Spotlight-style bar used by Cmd+Shift+F */}
        <div className="flex items-center gap-3 px-5 py-4 shrink-0">
          <MagnifyingGlass size={20} className="text-muted shrink-0" weight="bold" />
          <input
            ref={inputRef}
            type="text"
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value)
              setSelectedIndex(0)
            }}
            placeholder="Search across files, terminals, commands and more..."
            className="flex-1 bg-transparent text-primary text-base font-medium outline-none placeholder:text-muted placeholder:font-normal"
          />
        </div>

        {/* Results list */}
        <div className="flex-1 overflow-y-auto pb-2">
          {totalItems === 0 ? (
            <div className="text-muted text-sm text-center py-6">
              No matching results
            </div>
          ) : showRecommended ? (
            <>
              {/* Open panels first */}
              {recommendedPanels.length > 0 && (
                <>
                  <div className="px-5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">Open Panels</div>
                  {recommendedPanels.map((panel, i) => {
                    const isSelected = i === selectedIndex
                    const iconForType = panel.type === 'terminal' ? <TerminalIcon /> : panel.type === 'browser' ? <GlobeIcon /> : panel.type === 'agent' ? <AgentIcon /> : <FileTextIcon />
                    const colorForType = panel.type === 'terminal' ? 'bg-green-500/15 text-green-400' : panel.type === 'browser' ? 'bg-cyan-500/15 text-cyan-400' : panel.type === 'agent' ? 'bg-blue-500/15 text-blue-400' : 'bg-amber-500/15 text-amber-400'
                    return (
                      <div
                        key={panel.id}
                        className={`flex items-center gap-3 mx-2 px-3 py-2 cursor-pointer rounded-lg ${
                          isSelected ? 'bg-blue-600/30' : 'hover:bg-white/5'
                        }`}
                        onClick={() => {
                          const cs = canvasApi.getState()
                          const nodeEntry = Object.values(cs.nodes).find((n) => n.panelId === panel.id)
                          if (nodeEntry) cs.focusNode(nodeEntry.id)
                          close()
                        }}
                        onMouseEnter={() => setSelectedIndex(i)}
                      >
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${colorForType}`}>
                          {iconForType}
                        </div>
                        <span className="text-sm text-primary font-medium flex-1 truncate">{panel.title}</span>
                        <span className="text-[10px] text-muted capitalize">{panel.type}</span>
                      </div>
                    )
                  })}
                </>
              )}

              {/* Recommended files */}
              {recommendedFiles.length > 0 && (
                <>
                  {recommendedPanels.length > 0 && <div className="mx-5 my-1 border-t border-white/10" />}
                  <div className="px-5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">Files</div>
                  {recommendedFiles.map((file, i) => {
                    const itemIndex = recommendedPanels.length + i
                    const isSelected = itemIndex === selectedIndex
                    return (
                      <div
                        key={file}
                        className={`flex items-center gap-3 mx-2 px-3 py-2 cursor-pointer rounded-lg ${
                          isSelected ? 'bg-blue-600/30' : 'hover:bg-white/5'
                        }`}
                        onClick={() => {
                          const wsId = useAppStore.getState().selectedWorkspaceId
                          const fullPath = rootPath ? `${rootPath}/${file}` : file
                          useAppStore.getState().createEditor(wsId, fullPath, undefined, dockCenter)
                          close()
                        }}
                        onMouseEnter={() => setSelectedIndex(itemIndex)}
                      >
                        <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-amber-500/15 text-amber-400">
                          <FileTextIcon />
                        </div>
                        <span className="text-sm text-primary font-medium flex-1 truncate">{file}</span>
                      </div>
                    )
                  })}
                </>
              )}

              {/* Commands at bottom */}
              {filteredCommands.length > 0 && (
                <>
                  {(recommendedPanels.length > 0 || recommendedFiles.length > 0) && <div className="mx-5 my-1 border-t border-white/10" />}
                  <div className="px-5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">Commands</div>
                  {filteredCommands.map((cmd, i) => {
                    const itemIndex = recommendedPanels.length + recommendedFiles.length + i
                    const isSelected = itemIndex === selectedIndex
                    return (
                      <div
                        key={cmd.id}
                        className={`flex items-center gap-3 mx-2 px-3 py-2 cursor-pointer rounded-lg ${
                          isSelected ? 'bg-blue-600/30' : 'hover:bg-white/5'
                        }`}
                        onClick={() => executeCommand(cmd)}
                        onMouseEnter={() => setSelectedIndex(itemIndex)}
                      >
                        <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-blue-500/15 text-blue-400">
                          {cmd.icon}
                        </div>
                        <span className="text-sm text-primary font-medium flex-1 truncate">{cmd.title}</span>
                        {cmd.shortcutText && (
                          <span className="text-[11px] text-muted flex-shrink-0 font-mono">
                            {cmd.shortcutText}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </>
              )}
            </>
          ) : (
            <>
              {/* Search results: commands */}
              {filteredCommands.map((cmd, index) => {
                const isSelected = index === selectedIndex
                return (
                  <div
                    key={cmd.id}
                    className={`flex items-center gap-3 mx-2 px-3 py-2 cursor-pointer rounded-lg ${
                      isSelected ? 'bg-blue-600/30' : 'hover:bg-white/5'
                    }`}
                    onClick={() => executeCommand(cmd)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-blue-500/15 text-blue-400">
                      {cmd.icon}
                    </div>
                    <span className="text-sm text-primary font-medium flex-1 truncate">{cmd.title}</span>
                    {cmd.shortcutText && (
                      <span className="text-[11px] text-muted flex-shrink-0 font-mono">
                        {cmd.shortcutText}
                      </span>
                    )}
                  </div>
                )
              })}

              {/* Search results: matching files */}
              {matchingFiles.length > 0 && (
                <>
                  {filteredCommands.length > 0 && <div className="mx-5 my-1 border-t border-white/10" />}
                  {matchingFiles.map((file, i) => {
                    const fileIndex = filteredCommands.length + i
                    const isSelected = fileIndex === selectedIndex
                    return (
                      <div
                        key={file}
                        className={`flex items-center gap-3 mx-2 px-3 py-2 cursor-pointer rounded-lg ${
                          isSelected ? 'bg-blue-600/30' : 'hover:bg-white/5'
                        }`}
                        onClick={() => {
                          const wsId = useAppStore.getState().selectedWorkspaceId
                          const fullPath = rootPath ? `${rootPath}/${file}` : file
                          useAppStore.getState().createEditor(wsId, fullPath, undefined, dockCenter)
                          close()
                        }}
                        onMouseEnter={() => setSelectedIndex(fileIndex)}
                      >
                        <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-amber-500/15 text-amber-400">
                          <FileTextIcon />
                        </div>
                        <span className="text-sm text-primary font-medium flex-1 truncate">{file}</span>
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
