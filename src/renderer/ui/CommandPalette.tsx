// =============================================================================
// CommandPalette — Searchable command launcher overlay.
// Ported from commandPaletteItems in MainWindowView.swift
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUIStore } from '../stores/uiStore'
import { useAppStore } from '../stores/appStore'
import { useCanvasStore } from '../stores/canvasStore'

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

// Inline SVG icons
function TerminalIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )
}

function GlobeIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

function FileTextIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  )
}

function SidebarIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  )
}

function FolderOpenIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <path d="M2 10h20" />
    </svg>
  )
}

function LayersIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  )
}

function ZoomResetIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  )
}

function ZoomToFitIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  )
}

function RectangleIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    </svg>
  )
}

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
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const toggleFileExplorer = useUIStore((s) => s.toggleFileExplorer)
  const setZoom = useCanvasStore((s) => s.setZoom)

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

  // Build command items
  const allCommands: CommandItem[] = useMemo(
    () => [
      {
        id: 'newTerminal',
        title: 'New Terminal',
        shortcutText: '\u2318T',
        icon: <TerminalIcon />,
        action: () => createTerminal(selectedWorkspaceId),
      },
      {
        id: 'newBrowser',
        title: 'New Browser',
        shortcutText: '\u2318\u21E7B',
        icon: <GlobeIcon />,
        action: () => createBrowser(selectedWorkspaceId),
      },
      {
        id: 'newEditor',
        title: 'New Editor',
        shortcutText: '\u2318\u21E7E',
        icon: <FileTextIcon />,
        action: () => createEditor(selectedWorkspaceId),
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
        action: () => toggleFileExplorer(),
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
        action: () => useCanvasStore.getState().zoomToFit(),
      },
      {
        id: 'autoLayout',
        title: 'Auto-Layout Panels',
        shortcutText: '',
        icon: <LayersIcon />,
        action: () => useCanvasStore.getState().autoLayout(),
      },
      {
        id: 'newRegion',
        title: 'New Region',
        shortcutText: '',
        icon: <RectangleIcon />,
        action: () => useCanvasStore.getState().addRegion('Region', { x: 200, y: 200 }, { width: 400, height: 300 }),
      },
    ],
    [
      selectedWorkspaceId,
      createTerminal,
      createBrowser,
      createEditor,
      toggleSidebar,
      toggleFileExplorer,
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
              useAppStore.getState().createEditor(wsId, fullPath)
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
        className="w-96 bg-[#2A2A32] rounded-xl border border-white/[0.12] shadow-2xl overflow-hidden"
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
            className="w-full h-10 bg-transparent text-sm text-white/90 placeholder-white/30 outline-none"
          />
        </div>

        {/* Divider */}
        <div className="border-b border-white/10" />

        {/* Commands list */}
        <div className="max-h-[300px] overflow-y-auto py-1">
          {filteredCommands.length === 0 && matchingFiles.length === 0 ? (
            <div className="text-white/40 text-sm text-center py-4">
              No matching commands
            </div>
          ) : (
            <>
              {filteredCommands.map((cmd, index) => (
                <div
                  key={cmd.id}
                  className={`flex items-center px-3 py-2 gap-3 cursor-pointer transition-colors ${
                    index === selectedIndex
                      ? 'bg-white/[0.1]'
                      : 'hover:bg-white/[0.05]'
                  }`}
                  onClick={() => executeCommand(cmd)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <span className="text-white/60 flex-shrink-0">{cmd.icon}</span>
                  <span className="text-sm text-white/90 flex-1">{cmd.title}</span>
                  <span className="text-xs text-white/40 flex-shrink-0">
                    {cmd.shortcutText}
                  </span>
                </div>
              ))}
              {matchingFiles.length > 0 && (
                <>
                  <div className="px-3 py-1 text-xs text-zinc-500 uppercase tracking-wider">
                    Files
                  </div>
                  {matchingFiles.map((file, i) => {
                    const fileIndex = filteredCommands.length + i
                    return (
                      <div
                        key={file}
                        className={`flex items-center px-3 py-2 gap-3 cursor-pointer transition-colors ${
                          fileIndex === selectedIndex
                            ? 'bg-white/[0.1]'
                            : 'hover:bg-white/[0.05]'
                        }`}
                        onClick={() => {
                          const wsId = useAppStore.getState().selectedWorkspaceId
                          const fullPath = rootPath ? `${rootPath}/${file}` : file
                          useAppStore.getState().createEditor(wsId, fullPath)
                          close()
                        }}
                        onMouseEnter={() => setSelectedIndex(fileIndex)}
                      >
                        <span className="text-white/60 flex-shrink-0">
                          <FileTextIcon />
                        </span>
                        <span className="text-sm text-white/90 flex-1 truncate">{file}</span>
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
