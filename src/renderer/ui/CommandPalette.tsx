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
  ArrowsClockwise,
  Trash,
  GraduationCap,
} from '@phosphor-icons/react'
import type { PanelType } from '../../shared/types'
import { CateLogo } from './CateLogo'
import { BACKDROP, CARD_SURFACE } from './Modal'
import { useUIStore } from '../stores/uiStore'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { revealPanel } from '../lib/workspace/panelReveal'
import { openFileAsPanel } from '../lib/fs/fileRouting'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'

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
const SaveIcon = () => <FloppyDisk size={ICON_SIZE} />
const ReloadIcon = () => <ArrowsClockwise size={ICON_SIZE} />
const DeleteCompanionIcon = () => <Trash size={ICON_SIZE} />
const TutorialIcon = () => <GraduationCap size={ICON_SIZE} />
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
  // The reinstall command is only meaningful for a remote (ssh/wsl) workspace.
  const isRemoteWorkspace = useAppStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
    return !!ws?.connection && ws.connection.kind !== 'local'
  })
  const deleteCompanion = useAppStore((s) => s.deleteCompanion)

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
        title: 'New Cate agent',
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
        id: 'manageLayouts',
        title: 'Saved Layouts…',
        shortcutText: '',
        icon: <SaveIcon />,
        action: () => useUIStore.getState().setShowLayoutsDialog(true),
      },
      {
        id: 'showTutorial',
        title: 'Show Tutorial',
        shortcutText: '',
        icon: <TutorialIcon />,
        // Replays the first-run guided tour by clearing the completed flag.
        action: () => {
          useSettingsStore.getState().setSetting('onboardingCompleted', false)
          try { window.electronAPI?.trackFeatureUsed?.('onboarding_replayed') } catch { /* noop */ }
        },
      },
      {
        id: 'reloadWorkspace',
        title: 'Reload Workspace from Disk',
        shortcutText: '',
        icon: <ReloadIcon />,
        action: () => {
          void import('../lib/workspace/session').then((m) => m.reloadActiveWorkspaceFromDisk())
        },
      },
      // Remote-only: delete the daemon from the host. Main re-probes to the
      // 'missing' phase; the canvas lock then offers "Install Companion" for a
      // clean reinstall — the deliberate delete → install two-step.
      ...(isRemoteWorkspace
        ? [{
            id: 'deleteCompanion',
            title: 'Delete Companion',
            shortcutText: '',
            icon: <DeleteCompanionIcon />,
            action: () => { void deleteCompanion(selectedWorkspaceId) },
          }]
        : []),
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
      isRemoteWorkspace,
      deleteCompanion,
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
        const bufferLines = (terminalRegistry.captureScrollback(entry) ?? '').split('\n')
        let matches = 0
        for (let i = 0; i < bufferLines.length && matches < 5; i++) {
          const text = bufferLines[i]
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
          const hits = await window.electronAPI.fsSearch(workspace.rootPath, searchText, { maxResults: 50 }, workspace.id)
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

  // Focus an open panel by id via the shared resolver: reveal it in its dock
  // zone or pan/center its canvas node, using the canonical multi-canvas probe
  // order. Shared by the "Open Panels" click + Enter handlers and the panel
  // search results.
  const focusPanelById = useCallback(
    (panelId: string) => {
      void revealPanel(selectedWorkspaceId, panelId)
    },
    [selectedWorkspaceId],
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
          focusPanelById(result.panelId)
        }
      }
      close()
    },
    [canvasApi, close, focusPanelById],
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
                focusPanelById(panel.id)
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
  }, [showCommandPalette, filteredCommands, searchResults, recommendedPanels, showRecommended, selectedIndex, totalItems, executeCommand, selectSearchResult, close, canvasApi, focusPanelById])

  // Group search results by kind for section headers. Must run before the
  // early return below — a hook called conditionally changes the hook order
  // between renders and crashes React when the palette is toggled.
  const groupedResults = useMemo(() => {
    const seen = new Set<SearchResultKind>()
    const sections: { kind: SearchResultKind; items: SearchResult[] }[] = []
    for (const r of searchResults) {
      if (!seen.has(r.kind)) { seen.add(r.kind); sections.push({ kind: r.kind, items: [] }) }
      sections.find((s) => s.kind === r.kind)!.items.push(r)
    }
    return sections
  }, [searchResults])

  if (!showCommandPalette) return null

  const sectionLabel = (kind: SearchResultKind) =>
    kind === 'file' ? 'Files' : kind === 'panel' ? 'Panels' : 'Terminals'

  let flatSearchIndex = filteredCommands.length

  return (
    <div
      className={`fixed inset-0 flex justify-center z-50 ${BACKDROP}`}
      onClick={close}
    >
      <div
        data-onboarding="command-palette"
        className={`w-[600px] max-w-[600px] max-h-[440px] mt-[120px] overflow-hidden flex flex-col self-start ${CARD_SURFACE}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="p-2 shrink-0">
          <div className="flex items-center gap-2 px-2.5 h-8 rounded-md bg-surface-0/60 border border-strong focus-within:border-[rgba(255,255,255,0.18)] transition-colors">
            <MagnifyingGlass size={15} className="text-muted shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={searchText}
              onChange={(e) => {
                setSearchText(e.target.value)
                setSelectedIndex(0)
              }}
              placeholder="Search files, panels, terminals and more by name"
              className="flex-1 bg-transparent text-primary text-[13px] outline-none placeholder:text-muted"
            />
          </div>
        </div>

        {/* Results list */}
        <div className="flex-1 overflow-y-auto pb-1.5">
          {totalItems === 0 && !searching ? (
            <div className="text-muted text-[13px] text-center py-5">
              {searchText.length >= 2 ? 'No results' : 'No matching results'}
            </div>
          ) : showRecommended ? (
            <>
              {/* Open panels */}
              {recommendedPanels.length > 0 && (
                <>
                  <SectionHeader>Open Panels</SectionHeader>
                  {recommendedPanels.map((panel, i) => {
                    const isSelected = i === selectedIndex
                    const iconForType = panel.type === 'terminal' ? <TerminalIcon /> : panel.type === 'browser' ? <GlobeIcon /> : panel.type === 'agent' ? <AgentIcon /> : <FileTextIcon />
                    const colorForType = panel.type === 'terminal' ? 'text-emerald-400' : panel.type === 'browser' ? 'text-sky-400' : panel.type === 'agent' ? 'text-[rgb(var(--agent-rgb))]' : 'text-amber-400'
                    return (
                      <Row
                        key={panel.id}
                        selected={isSelected}
                        onClick={() => { focusPanelById(panel.id); close() }}
                        onMouseEnter={() => setSelectedIndex(i)}
                      >
                        <span className={`shrink-0 ${colorForType}`}>{iconForType}</span>
                        <span className="text-[13px] text-primary flex-1 truncate">{panel.title}</span>
                        <span className="text-[11px] text-muted capitalize">{panel.type}</span>
                      </Row>
                    )
                  })}
                </>
              )}

              {/* Commands */}
              {filteredCommands.length > 0 && (
                <>
                  {recommendedPanels.length > 0 && <Separator />}
                  <SectionHeader>Commands</SectionHeader>
                  {filteredCommands.map((cmd, i) => {
                    const itemIndex = recommendedPanels.length + i
                    const isSelected = itemIndex === selectedIndex
                    return (
                      <Row
                        key={cmd.id}
                        selected={isSelected}
                        onClick={() => executeCommand(cmd)}
                        onMouseEnter={() => setSelectedIndex(itemIndex)}
                      >
                        <span className="shrink-0 text-secondary">{cmd.icon}</span>
                        <span className="text-[13px] text-primary flex-1 truncate">{cmd.title}</span>
                        <Shortcut text={cmd.shortcutText} />
                      </Row>
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
                  <SectionHeader>Commands</SectionHeader>
                  {filteredCommands.map((cmd, index) => {
                    const isSelected = index === selectedIndex
                    return (
                      <Row
                        key={cmd.id}
                        selected={isSelected}
                        onClick={() => executeCommand(cmd)}
                        onMouseEnter={() => setSelectedIndex(index)}
                      >
                        <span className="shrink-0 text-secondary">{cmd.icon}</span>
                        <span className="text-[13px] text-primary flex-1 truncate">{cmd.title}</span>
                        <Shortcut text={cmd.shortcutText} />
                      </Row>
                    )
                  })}
                </>
              )}

              {/* Search results grouped by kind */}
              {groupedResults.map((section, si) => {
                const showSeparator = si > 0 || filteredCommands.length > 0
                return (
                  <div key={section.kind}>
                    {showSeparator && <Separator />}
                    <SectionHeader>{sectionLabel(section.kind)}</SectionHeader>
                    {section.items.map((r) => {
                      const thisIndex = flatSearchIndex++
                      const isSelected = thisIndex === selectedIndex
                      return (
                        <Row
                          key={r.key}
                          selected={isSelected}
                          onClick={() => selectSearchResult(r)}
                          onMouseEnter={() => setSelectedIndex(thisIndex)}
                        >
                          <SearchResultIcon result={r} />
                          <div className="flex-1 min-w-0">
                            <div className="text-primary text-[13px] truncate">{r.primary}</div>
                            <div className="text-muted text-[11px] truncate">{r.secondary}</div>
                          </div>
                        </Row>
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
// Layout primitives — slim rows, section headers, separators, keycap shortcuts
// -----------------------------------------------------------------------------

const Row: React.FC<{
  selected: boolean
  onClick: () => void
  onMouseEnter: () => void
  children: React.ReactNode
}> = ({ selected, onClick, onMouseEnter, children }) => (
  <div
    className={`flex items-center gap-2.5 mx-1.5 px-2.5 py-1.5 cursor-pointer rounded-md ${
      selected ? 'bg-[rgb(var(--agent-rgb))]/12' : ''
    }`}
    onClick={onClick}
    onMouseEnter={onMouseEnter}
  >
    {children}
  </div>
)

const SectionHeader: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-3.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
    {children}
  </div>
)

const Separator: React.FC = () => <div className="mx-3.5 my-1 border-t border-subtle" />

// Render a shortcut string (e.g. "⌘⇧B", "⌃Space") as individual keycaps.
const Shortcut: React.FC<{ text: string }> = ({ text }) => {
  if (!text) return null
  const mods = new Set(['⌘', '⌥', '⌃', '⇧'])
  const keys: string[] = []
  let rest = ''
  for (const ch of text) {
    if (mods.has(ch)) keys.push(ch)
    else rest += ch
  }
  if (rest) keys.push(rest)
  return (
    <span className="flex items-center gap-1 shrink-0">
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="min-w-[18px] h-[18px] px-1 rounded border border-strong bg-surface-4 text-secondary text-[10px] leading-none flex items-center justify-center"
        >
          {k}
        </kbd>
      ))}
    </span>
  )
}

// -----------------------------------------------------------------------------
// Search result icon — bare type-aware glyph
// -----------------------------------------------------------------------------

function SearchResultIcon({ result }: { result: SearchResult }) {
  const cls = 'shrink-0'
  if (result.kind === 'file') return <span className={`${cls} text-amber-400`}><FileText size={ICON_SIZE} /></span>
  if (result.kind === 'terminal') return <span className={`${cls} text-emerald-400`}><Terminal size={ICON_SIZE} /></span>
  const { panelType } = result
  if (panelType === 'terminal') return <span className={`${cls} text-emerald-400`}><Terminal size={ICON_SIZE} /></span>
  if (panelType === 'browser')  return <span className={`${cls} text-sky-400`}><Globe size={ICON_SIZE} /></span>
  if (panelType === 'editor')   return <span className={`${cls} text-orange-400`}><FileText size={ICON_SIZE} /></span>
  return <span className={`${cls} text-violet-400`}><Square size={ICON_SIZE} /></span>
}
