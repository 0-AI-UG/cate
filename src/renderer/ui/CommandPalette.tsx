// =============================================================================
// CommandPalette — Unified searchable command launcher + workspace navigator.
// A single Cmd+K overlay listing all commands, all open panels, and workspace
// files. Files and panels are matched by NAME ONLY (no content search — that's
// the separate ripgrep-backed Search view). With no query typed, it lists all
// commands, all open panels, and recently-opened files — so it's obvious the
// palette reaches panels and files too, not just commands.
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
  PuzzlePiece,
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
import { getRecentFiles } from '../lib/fs/recentFiles'

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
const SkillsIcon = () => <PuzzlePiece size={ICON_SIZE} />
const AgentIcon = () => <CateLogo size={ICON_SIZE} />

// -----------------------------------------------------------------------------
// Result types
// -----------------------------------------------------------------------------

interface FileResult {
  path: string
  name: string
  relativePath: string
}

interface PanelResult {
  panelId: string
  title: string
  type: PanelType
  secondary: string
  nodeId?: string
  recency: number
}

// A single navigable entry in the flat list, used for keyboard selection.
type FlatItem =
  | { kind: 'command'; command: CommandItem }
  | { kind: 'panel'; panel: PanelResult }
  | { kind: 'file'; file: FileResult }

// Panel types worth surfacing as navigable destinations.
const NAVIGABLE_PANEL_TYPES: PanelType[] = ['terminal', 'editor', 'browser', 'agent', 'document']

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

  // The reinstall command is only meaningful for a remote (ssh/wsl) workspace.
  const isRemoteWorkspace = useAppStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
    return !!ws?.connection && ws.connection.kind !== 'local'
  })
  const deleteCompanion = useAppStore((s) => s.deleteCompanion)

  const [searchText, setSearchText] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [fileResults, setFileResults] = useState<FileResult[]>([])
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const close = useCallback(() => {
    setShowCommandPalette(false)
    setSearchText('')
    setSelectedIndex(0)
    setFileResults([])
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
        id: 'skills',
        title: 'Skills…',
        shortcutText: '',
        icon: <SkillsIcon />,
        action: () => useUIStore.getState().setShowSkillsDialog(true),
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

  // Open panels in the current workspace.
  const openPanels = useAppStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
    if (!ws) return []
    return Object.values(ws.panels)
  }))

  const rootPath = useAppStore((s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId)?.rootPath)

  const query = searchText.trim().toLowerCase()

  // Commands matched by title (empty query → all).
  const filteredCommands = useMemo(() => {
    if (!query) return allCommands
    return allCommands.filter((cmd) => cmd.title.toLowerCase().includes(query))
  }, [allCommands, query])

  // Panels matched by title only. Ranked most-recently-focused first.
  const filteredPanels = useMemo<PanelResult[]>(() => {
    const cs = canvasApi.getState()
    const focusedNodeId = cs.focusedNodeId
    const nodeByPanelId = new Map<string, { id: string; creationIndex: number }>()
    for (const n of Object.values(cs.nodes)) nodeByPanelId.set(n.panelId, { id: n.id, creationIndex: n.creationIndex })

    const results: PanelResult[] = []
    for (const panel of openPanels) {
      if (!NAVIGABLE_PANEL_TYPES.includes(panel.type)) continue
      const title = panel.title ?? panel.type
      if (query && !title.toLowerCase().includes(query)) continue
      const n = nodeByPanelId.get(panel.id)
      results.push({
        panelId: panel.id,
        title,
        type: panel.type,
        secondary: panel.filePath ?? panel.url ?? panel.type,
        nodeId: n?.id,
        recency: n ? (focusedNodeId === n.id ? Number.MAX_SAFE_INTEGER : n.creationIndex) : 0,
      })
    }
    results.sort((a, b) => b.recency - a.recency)
    return results
  }, [openPanels, query, canvasApi])

  // With a query, search workspace files by name (debounced). With an empty box,
  // skip the filesystem walk and show recently-opened files instead.
  useEffect(() => {
    if (!showCommandPalette || !query) { setFileResults([]); return }
    const ws = useAppStore.getState().workspaces.find(
      (w) => w.id === useAppStore.getState().selectedWorkspaceId,
    )
    if (!ws?.rootPath) { setFileResults([]); return }

    setSearching(true)
    const timer = setTimeout(async () => {
      try {
        const hits = await window.electronAPI.fsSearch(ws.rootPath!, searchText, { maxResults: 50 }, ws.id)
        setFileResults(
          hits
            .filter((h) => !h.isDirectory)
            .map((h) => ({ path: h.path, name: h.name, relativePath: h.relativePath })),
        )
      } catch {
        setFileResults([])
      }
      setSearching(false)
    }, 200)

    return () => { clearTimeout(timer); setSearching(false) }
  }, [searchText, query, showCommandPalette])

  // Recently-opened files, shown when the search box is empty. Skip files that
  // are already open (they appear under Panels), and resolve a display name/path.
  const recentFileResults = useMemo<FileResult[]>(() => {
    if (query) return []
    const openPaths = new Set(openPanels.map((p) => p.filePath).filter(Boolean) as string[])
    return getRecentFiles(selectedWorkspaceId)
      .filter((p) => !openPaths.has(p))
      .map((p) => ({
        path: p,
        name: p.split('/').pop() ?? p,
        relativePath: rootPath && p.startsWith(rootPath) ? p.slice(rootPath.length).replace(/^\/+/, '') : p,
      }))
  }, [query, openPanels, selectedWorkspaceId, rootPath])

  const displayedFiles = query ? fileResults : recentFileResults

  // Flat list of every navigable item, in render order. Drives keyboard nav.
  const flatItems = useMemo<FlatItem[]>(() => [
    ...filteredCommands.map((command) => ({ kind: 'command', command }) as FlatItem),
    ...filteredPanels.map((panel) => ({ kind: 'panel', panel }) as FlatItem),
    ...displayedFiles.map((file) => ({ kind: 'file', file }) as FlatItem),
  ], [filteredCommands, filteredPanels, displayedFiles])

  const totalItems = flatItems.length

  // Clamp selection when the list changes.
  useEffect(() => {
    setSelectedIndex((prev) => (prev >= totalItems ? Math.max(0, totalItems - 1) : prev))
  }, [totalItems])

  // Focus input when shown.
  useEffect(() => {
    if (showCommandPalette) {
      setSearchText('')
      setSelectedIndex(0)
      setFileResults([])
      requestAnimationFrame(() => { inputRef.current?.focus() })
    }
  }, [showCommandPalette])

  const focusPanelById = useCallback(
    (panelId: string) => { void revealPanel(selectedWorkspaceId, panelId) },
    [selectedWorkspaceId],
  )

  const openFile = useCallback(
    (file: FileResult) => {
      const appStore = useAppStore.getState()
      const wsId = appStore.selectedWorkspaceId
      const ws = appStore.workspaces.find((w) => w.id === wsId)
      let panelId: string | undefined
      if (ws) {
        const existing = Object.values(ws.panels).find(
          (p) => (p.type === 'editor' || p.type === 'document') && p.filePath === file.path,
        )
        panelId = existing?.id
      }
      if (!panelId) panelId = openFileAsPanel(wsId, file.path)
      const cs = canvasApi.getState()
      const node = panelId ? Object.values(cs.nodes).find((n) => n.panelId === panelId) : undefined
      if (node) cs.focusAndCenter(node.id)
    },
    [canvasApi],
  )

  const activate = useCallback(
    (item: FlatItem) => {
      close()
      if (item.kind === 'command') {
        item.command.action()
      } else if (item.kind === 'panel') {
        if (item.panel.nodeId) canvasApi.getState().focusAndCenter(item.panel.nodeId)
        else focusPanelById(item.panel.panelId)
      } else {
        openFile(item.file)
      }
    },
    [close, canvasApi, focusPanelById, openFile],
  )

  // Keyboard navigation
  useEffect(() => {
    if (!showCommandPalette) return

    function handleKey(e: KeyboardEvent) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) => (totalItems === 0 ? 0 : (prev + 1) % totalItems))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) => (totalItems === 0 ? 0 : (prev - 1 + totalItems) % totalItems))
          break
        case 'Enter': {
          e.preventDefault()
          const item = flatItems[selectedIndex]
          if (item) activate(item)
          break
        }
        case 'Escape':
          e.preventDefault()
          close()
          break
      }
    }

    document.addEventListener('keydown', handleKey, { capture: true })
    return () => document.removeEventListener('keydown', handleKey, { capture: true })
  }, [showCommandPalette, flatItems, selectedIndex, totalItems, activate, close])

  if (!showCommandPalette) return null

  // Section boundaries within the flat list.
  const panelStart = filteredCommands.length
  const fileStart = panelStart + filteredPanels.length
  const filesLabel = query ? 'Files' : 'Recent Files'

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
              onChange={(e) => { setSearchText(e.target.value); setSelectedIndex(0) }}
              placeholder="Search commands, panels and files by name"
              className="flex-1 bg-transparent text-primary text-[13px] outline-none placeholder:text-muted"
            />
          </div>
        </div>

        {/* Results list */}
        <div className="flex-1 overflow-y-auto pb-1.5">
          {totalItems === 0 ? (
            <div className="text-muted text-[13px] text-center py-5">
              {searching ? 'Searching…' : 'No results'}
            </div>
          ) : (
            <>
              {/* Commands */}
              {filteredCommands.length > 0 && (
                <>
                  <SectionHeader>Commands</SectionHeader>
                  {filteredCommands.map((cmd, i) => {
                    const isSelected = i === selectedIndex
                    return (
                      <Row
                        key={cmd.id}
                        selected={isSelected}
                        onClick={() => activate({ kind: 'command', command: cmd })}
                        onMouseEnter={() => setSelectedIndex(i)}
                      >
                        <span className="shrink-0 text-secondary">{cmd.icon}</span>
                        <span className="text-[13px] text-primary flex-1 truncate">{cmd.title}</span>
                        <Shortcut text={cmd.shortcutText} />
                      </Row>
                    )
                  })}
                </>
              )}

              {/* Panels */}
              {filteredPanels.length > 0 && (
                <>
                  {filteredCommands.length > 0 && <Separator />}
                  <SectionHeader>Panels</SectionHeader>
                  {filteredPanels.map((panel, i) => {
                    const itemIndex = panelStart + i
                    const isSelected = itemIndex === selectedIndex
                    return (
                      <Row
                        key={panel.panelId}
                        selected={isSelected}
                        onClick={() => activate({ kind: 'panel', panel })}
                        onMouseEnter={() => setSelectedIndex(itemIndex)}
                      >
                        <PanelIcon type={panel.type} />
                        <span className="text-[13px] text-primary flex-1 truncate">{panel.title}</span>
                        <span className="text-[11px] text-muted capitalize">{panel.type}</span>
                      </Row>
                    )
                  })}
                </>
              )}

              {/* Files */}
              {displayedFiles.length > 0 && (
                <>
                  {(filteredCommands.length > 0 || filteredPanels.length > 0) && <Separator />}
                  <SectionHeader>{filesLabel}</SectionHeader>
                  {displayedFiles.map((file, i) => {
                    const itemIndex = fileStart + i
                    const isSelected = itemIndex === selectedIndex
                    return (
                      <Row
                        key={file.path}
                        selected={isSelected}
                        onClick={() => activate({ kind: 'file', file })}
                        onMouseEnter={() => setSelectedIndex(itemIndex)}
                      >
                        <span className="shrink-0 text-amber-400"><FileText size={ICON_SIZE} /></span>
                        <div className="flex-1 min-w-0">
                          <div className="text-primary text-[13px] truncate">{file.name}</div>
                          <div className="text-muted text-[11px] truncate">{file.relativePath}</div>
                        </div>
                      </Row>
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
// Panel icon — type-aware glyph matching the canvas panel colors
// -----------------------------------------------------------------------------

function PanelIcon({ type }: { type: PanelType }) {
  const cls = 'shrink-0'
  if (type === 'terminal') return <span className={`${cls} text-emerald-400`}><Terminal size={ICON_SIZE} /></span>
  if (type === 'browser')  return <span className={`${cls} text-sky-400`}><Globe size={ICON_SIZE} /></span>
  if (type === 'editor' || type === 'document') return <span className={`${cls} text-orange-400`}><FileText size={ICON_SIZE} /></span>
  if (type === 'agent')    return <span className={`${cls} text-[rgb(var(--agent-rgb))]`}><CateLogo size={ICON_SIZE} /></span>
  return <span className={`${cls} text-violet-400`}><Square size={ICON_SIZE} /></span>
}
