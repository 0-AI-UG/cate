// =============================================================================
// CommandPalette — Unified searchable command launcher + workspace search.
// Handles commands, file search (name + content), terminal scrollback,
// and open panel switching — all from a single Cmd+K overlay.
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
  GitBranch,
} from '@phosphor-icons/react'
import type { PanelType } from '../../shared/types'
import { CateLogo } from './CateLogo'
import { useUIStore } from '../stores/uiStore'
import { useAppStore } from '../stores/appStore'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useDockStore } from '../stores/dockStore'
import { findTabStack } from '../stores/dockTreeUtils'
import { openFileAsPanel } from '../lib/fileRouting'
import { terminalRegistry } from '../lib/terminalRegistry'

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
const AgentIcon = () => <CateLogo size={ICON_SIZE} />

// -----------------------------------------------------------------------------
// Search result types (merged from GlobalSearch)
// -----------------------------------------------------------------------------

type SearchResultKind = 'file' | 'panel' | 'terminal'

interface SearchResult {
  key: string
  kind: SearchResultKind
  primary: string
  secondary: string
  score: number
  filePath?: string
  line?: number
  panelId?: string
  panelType?: PanelType
  nodeId?: string
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

  const [searchText, setSearchText] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const close = useCallback(() => {
    setShowCommandPalette(false)
    setSearchText('')
    setSelectedIndex(0)
    setSearchResults([])
  }, [setShowCommandPalette])

  const dockCenter = { target: 'dock', zone: 'center' } as const

  // Build command items
  const allCommands: CommandItem[] = useMemo(
    () => [
      {
        id: 'newTerminal',
        title: 'New Terminal',
        shortcutText: '⌘T',
        icon: <TerminalIcon />,
        action: () => createTerminal(selectedWorkspaceId, undefined, undefined, dockCenter),
      },
      {
        id: 'newBrowser',
        title: 'New Browser',
        shortcutText: '⌘⇧B',
        icon: <GlobeIcon />,
        action: () => createBrowser(selectedWorkspaceId, undefined, undefined, dockCenter),
      },
      {
        id: 'newEditor',
        title: 'New Editor',
        shortcutText: '⌘⇧E',
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
        shortcutText: '⌘\\',
        icon: <SidebarIcon />,
        action: () => toggleSidebar(),
      },
      {
        id: 'toggleFileExplorer',
        title: 'Toggle File Explorer',
        shortcutText: '⌘⇧X',
        icon: <FolderOpenIcon />,
        action: () => { setActiveRightSidebarView('explorer') },
      },
      {
        id: 'nodeSwitcher',
        title: 'Switch Panel',
        shortcutText: '⌃Space',
        icon: <LayersIcon />,
        action: () => setShowNodeSwitcher(true),
      },
      {
        id: 'zoomReset',
        title: 'Reset Zoom',
        shortcutText: '⌘0',
        icon: <ZoomResetIcon />,
        action: () => setZoom(1.0),
      },
      {
        id: 'zoomToFit',
        title: 'Zoom to Fit',
        shortcutText: '⌘1',
        icon: <ZoomToFitIcon />,
        action: () => canvasApi.getState().zoomToFit(),
      },
      {
        id: 'autoLayout',
        title: 'Auto-Layout Canvas',
        shortcutText: '⇧⌘L',
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

  // When no search text, show open panels
  const showRecommended = !searchText.trim()
  const recommendedPanels = useMemo(() => {
    if (!showRecommended) return []
    return openPanels.filter((p) => p.type === 'terminal' || p.type === 'editor' || p.type === 'browser' || p.type === 'agent')
  }, [openPanels, showRecommended])

  // Filter commands by search text
  const filteredCommands = useMemo(() => {
    if (!searchText.trim()) return allCommands
    const lower = searchText.toLowerCase()
    return allCommands.filter((cmd) => cmd.title.toLowerCase().includes(lower))
  }, [allCommands, searchText])

  // Debounced deep search (files + terminals + panels) when user types 2+ chars
  useEffect(() => {
    if (!showCommandPalette) return
    if (searchText.length < 2) {
      setSearchResults([])
      return
    }

    setSearching(true)
    const timer = setTimeout(async () => {
      const q = searchText.toLowerCase()
      const workspace = useAppStore.getState().workspaces.find(
        (w) => w.id === useAppStore.getState().selectedWorkspaceId,
      )
      if (!workspace) { setSearching(false); return }

      const canvasNodes = canvasApi.getState().nodes
      const focusedNodeId = canvasApi.getState().focusedNodeId
      const nodeByPanelId = new Map<string, { id: string; creationIndex: number }>()
      for (const n of Object.values(canvasNodes)) {
        nodeByPanelId.set(n.panelId, { id: n.id, creationIndex: n.creationIndex })
      }

      const out: SearchResult[] = []

      // 1) Open panels (title + file path + URL)
      for (const panel of Object.values(workspace.panels)) {
        const title = panel.title ?? ''
        const fp = panel.filePath ?? ''
        const url = panel.url ?? ''
        const hay = `${title}\n${fp}\n${url}`.toLowerCase()
        if (!hay.includes(q)) continue
        const n = nodeByPanelId.get(panel.id)
        const recency = n ? (focusedNodeId === n.id ? 1_000_000 : n.creationIndex) : 0
        out.push({
          key: `panel:${panel.id}`,
          kind: 'panel',
          primary: title || panel.type,
          secondary: fp || url || panel.type,
          score: 2000 + recency,
          panelId: panel.id,
          panelType: panel.type,
          nodeId: n?.id,
        })
      }

      // 2) Terminal scrollback
      const terminalPanels = Object.values(workspace.panels).filter((p) => p.type === 'terminal')
      for (const panel of terminalPanels) {
        const entry = terminalRegistry.getEntry(panel.id)
        if (!entry) continue
        const buffer = entry.terminal.buffer.active
        const last = buffer.baseY + buffer.cursorY
        let matches = 0
        for (let i = 0; i < last && matches < 5; i++) {
          const line = buffer.getLine(i)
          if (!line) continue
          const text = line.translateToString(true)
          if (text.toLowerCase().includes(q)) {
            matches++
            const n = nodeByPanelId.get(panel.id)
            out.push({
              key: `term:${panel.id}:${i}`,
              kind: 'terminal',
              primary: `${panel.title}:${i + 1}`,
              secondary: text.trim().slice(0, 200),
              score: 1000 + (n ? n.creationIndex : 0),
              panelId: panel.id,
              nodeId: n?.id,
              line: i + 1,
            })
          }
        }
      }

      // 3) Workspace files (name + content) via fsSearch
      if (workspace.rootPath) {
        try {
          const hits = await window.electronAPI.fsSearch(workspace.rootPath, searchText, { maxResults: 50 })
          for (const h of hits) {
            if (h.isDirectory) continue
            out.push({
              key: `file:${h.path}${h.contentLine ?? ''}`,
              kind: 'file',
              primary: h.name + (h.contentLine ? `:${h.contentLine}` : ''),
              secondary: h.contentPreview?.trim().slice(0, 200) || h.relativePath,
              score: h.nameMatch ? 500 : 100,
              filePath: h.path,
              line: h.contentLine,
            })
          }
        } catch {
          /* filesystem search unavailable */
        }
      }

      out.sort((a, b) => b.score - a.score)
      setSearchResults(out.slice(0, 80))
      setSelectedIndex(0)
      setSearching(false)
    }, 250)

    return () => { clearTimeout(timer); setSearching(false) }
  }, [searchText, showCommandPalette, canvasApi])

  // Flat list of all items for keyboard navigation
  const totalItems = showRecommended
    ? recommendedPanels.length + filteredCommands.length
    : filteredCommands.length + searchResults.length

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
      setSearchResults([])
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

  const selectSearchResult = useCallback(
    async (result: SearchResult) => {
      const appStore = useAppStore.getState()
      const wsId = appStore.selectedWorkspaceId
      if (result.kind === 'file') {
        const ws = appStore.workspaces.find((w) => w.id === wsId)
        let panelId: string | undefined
        if (ws) {
          const existing = Object.values(ws.panels).find(
            (p) => (p.type === 'editor' || p.type === 'document') && p.filePath === result.filePath,
          )
          panelId = existing?.id
        }
        if (!panelId) {
          panelId = openFileAsPanel(wsId, result.filePath!)
        }
        const cs = canvasApi.getState()
        const node = panelId ? Object.values(cs.nodes).find((n) => n.panelId === panelId) : undefined
        if (node) cs.focusAndCenter(node.id)
      } else if (result.kind === 'panel' || result.kind === 'terminal') {
        if (result.nodeId) {
          canvasApi.getState().focusAndCenter(result.nodeId)
        } else if (result.panelId) {
          const dock = useDockStore.getState()
          const loc = dock.getPanelLocation(result.panelId)
          if (loc && loc.type === 'dock') {
            const zone = dock.zones[loc.zone]
            if (!zone.visible) dock.toggleZone(loc.zone)
            if (zone.layout) {
              const stack = findTabStack(zone.layout, loc.stackId)
              if (stack) {
                const idx = stack.panelIds.indexOf(result.panelId)
                if (idx >= 0) dock.setActiveTab(loc.stackId, idx)
              }
            }
          }
        }
      }
      close()
    },
    [canvasApi, close],
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
            if (selectedIndex < recommendedPanels.length) {
              const panel = recommendedPanels[selectedIndex]
              if (panel) {
                const cs = canvasApi.getState()
                const nodeEntry = Object.values(cs.nodes).find((n) => n.panelId === panel.id)
                if (nodeEntry) cs.focusNode(nodeEntry.id)
                close()
              }
            } else {
              const cmdIndex = selectedIndex - recommendedPanels.length
              const cmd = filteredCommands[cmdIndex]
              if (cmd) executeCommand(cmd)
            }
          } else {
            if (selectedIndex < filteredCommands.length) {
              const cmd = filteredCommands[selectedIndex]
              if (cmd) executeCommand(cmd)
            } else {
              const result = searchResults[selectedIndex - filteredCommands.length]
              if (result) selectSearchResult(result)
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
  }, [showCommandPalette, filteredCommands, searchResults, recommendedPanels, showRecommended, selectedIndex, totalItems, executeCommand, selectSearchResult, close, canvasApi])

  if (!showCommandPalette) return null

  // Group search results by kind for section headers
  const groupedResults = useMemo(() => {
    const seen = new Set<SearchResultKind>()
    const sections: { kind: SearchResultKind; items: SearchResult[] }[] = []
    for (const r of searchResults) {
      if (!seen.has(r.kind)) { seen.add(r.kind); sections.push({ kind: r.kind, items: [] }) }
      sections.find((s) => s.kind === r.kind)!.items.push(r)
    }
    return sections
  }, [searchResults])

  const sectionLabel = (kind: SearchResultKind) =>
    kind === 'file' ? 'Files' : kind === 'panel' ? 'Panels' : 'Terminals'

  let flatSearchIndex = filteredCommands.length

  return (
    <div
      className="fixed inset-0 bg-black/40 flex justify-center z-50"
      onClick={close}
    >
      <div
        className="w-[640px] max-w-[640px] max-h-[560px] mt-[160px] rounded-3xl overflow-hidden flex flex-col self-start bg-surface-4/85 backdrop-blur-2xl border border-white/20 shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
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
            placeholder="Search files, terminals, commands and more…"
            className="flex-1 bg-transparent text-primary text-base font-medium outline-none placeholder:text-muted placeholder:font-normal"
          />
        </div>

        {/* Results list */}
        <div className="flex-1 overflow-y-auto pb-2">
          {totalItems === 0 && !searching ? (
            <div className="text-muted text-sm text-center py-6">
              {searchText.length >= 2 ? 'No results' : 'No matching results'}
            </div>
          ) : showRecommended ? (
            <>
              {/* Open panels */}
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

              {/* Commands */}
              {filteredCommands.length > 0 && (
                <>
                  {recommendedPanels.length > 0 && <div className="mx-5 my-1 border-t border-white/10" />}
                  <div className="px-5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">Commands</div>
                  {filteredCommands.map((cmd, i) => {
                    const itemIndex = recommendedPanels.length + i
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
              {/* Matching commands */}
              {filteredCommands.length > 0 && (
                <>
                  <div className="px-5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">Commands</div>
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
                </>
              )}

              {/* Search results grouped by kind */}
              {groupedResults.map((section, si) => {
                const showSeparator = si > 0 || filteredCommands.length > 0
                return (
                  <div key={section.kind}>
                    {showSeparator && <div className="mx-5 my-1 border-t border-white/10" />}
                    <div className="px-5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{sectionLabel(section.kind)}</div>
                    {section.items.map((r) => {
                      const thisIndex = flatSearchIndex++
                      const isSelected = thisIndex === selectedIndex
                      return (
                        <div
                          key={r.key}
                          className={`flex items-center gap-3 mx-2 px-3 py-2 cursor-pointer rounded-lg ${
                            isSelected ? 'bg-blue-600/30' : 'hover:bg-white/5'
                          }`}
                          onClick={() => selectSearchResult(r)}
                          onMouseEnter={() => setSelectedIndex(thisIndex)}
                        >
                          <SearchResultIcon result={r} />
                          <div className="flex-1 min-w-0">
                            <div className="text-primary text-sm font-medium truncate">{r.primary}</div>
                            <div className="text-muted text-xs truncate mt-0.5">{r.secondary}</div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Search result icon — type-aware glyph in a tinted circle
// -----------------------------------------------------------------------------

function SearchResultIcon({ result }: { result: SearchResult }) {
  const tile = 'w-8 h-8 rounded-full flex items-center justify-center shrink-0'
  if (result.kind === 'file') {
    return <div className={`${tile} bg-amber-500/15 text-amber-400`}><FileText size={16} weight="bold" /></div>
  }
  if (result.kind === 'terminal') {
    return <div className={`${tile} bg-emerald-500/15 text-emerald-400`}><Terminal size={16} weight="bold" /></div>
  }
  const { panelType } = result
  if (panelType === 'terminal') return <div className={`${tile} bg-emerald-500/15 text-emerald-400`}><Terminal size={16} weight="bold" /></div>
  if (panelType === 'browser')  return <div className={`${tile} bg-sky-500/15 text-sky-400`}><Globe size={16} weight="bold" /></div>
  if (panelType === 'editor')   return <div className={`${tile} bg-orange-500/15 text-orange-400`}><FileText size={16} weight="bold" /></div>
  if (panelType === 'git')      return <div className={`${tile} bg-red-500/15 text-red-400`}><GitBranch size={16} weight="bold" /></div>
  if (panelType === 'fileExplorer') return <div className={`${tile} bg-cyan-500/15 text-cyan-400`}><FolderOpen size={16} weight="bold" /></div>
  if (panelType === 'projectList')  return <div className={`${tile} bg-yellow-500/15 text-yellow-400`}><Stack size={16} weight="bold" /></div>
  return <div className={`${tile} bg-violet-500/15 text-violet-400`}><Square size={16} weight="bold" /></div>
}
