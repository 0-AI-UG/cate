import { placementForPanel } from '../lib/workspace/canvasAccess'
// =============================================================================
// FileExplorer — Git-aware file tree browser.
// Ported from FileExplorerView.swift + FileTreeModel.swift
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import log from '../lib/logger'
import { RotateCw as ArrowClockwise, FilePlus, FolderPlus, Search as MagnifyingGlass, X } from 'lucide-react'
import type { FileTreeNode as FileTreeNodeType } from '../../shared/types'
import { VirtualFileRows, type VirtualFileRowsHandle } from './VirtualFileRows'
import { createExplorerRefresh } from './explorerRefresh'
import { perfCount } from '../lib/perf/perfClient'
import { FileTreeNode } from './FileTreeNode'
import { CreateFileForm } from './CreateFileForm'
import { isNavKey, resolveTreeNavAction } from './treeKeyboardNav'
import { watchFsRoot } from '../lib/fs/fsWatchManager'
import { useGitTreeFor } from '../stores/gitStatusStore'
import { getClipboard, hasClipboard } from './fileClipboard'
import { useAppStore } from '../stores/appStore'
import { openFileAsPanel } from '../lib/fs/fileRouting'
import { pathDisplayName, workspaceDisplayName } from '../lib/fs/displayPath'
import { isLocalLocator } from '../../shared/runtimeLocator'
import { isExternalFileDrag, importDroppedEntries } from '../lib/fs/importExternalEntries'
import { SidebarSectionHeader, SidebarHeaderButton } from './SidebarSectionHeader'
import { LoadingState } from '../ui/Spinner'
import { worktreeForPath } from '../lib/worktreeContext'

// Opening a workspace sets its root path optimistically in the renderer, but
// main only registers that path as an allowed root once the async workspace
// sync resolves. A read issued before then is rejected (it throws, rather than
// returning [] like a genuinely empty directory), so retry a few times to ride
// out that race instead of leaving the tree stuck empty until a manual reload.
const FS_READ_RETRIES = 5
const FS_READ_RETRY_DELAY_MS = 120

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

interface FileExplorerProps {
  workspaceId?: string
  panelId?: string
  rootPath: string
  scopeControl?: React.ReactNode
  onOpenFiles?: (paths: string[], mode?: 'dock' | 'canvas') => void
  compact?: boolean
}

// One entry per on-screen row, top to bottom (root nodes + children of expanded
// folders). Backbone for keyboard navigation and shift-click range ordering.
interface FlatRow {
  path: string
  depth: number
  isDirectory: boolean
  parentPath: string | null
  node: FileTreeNodeType
}

interface ExplorerView {
  nodes: FileTreeNodeType[]
  children: Map<string, FileTreeNodeType[]>
  expanded: Set<string>
  selected: Set<string>
}
// Two recently visited roots paint immediately while their loaded directories
// revalidate. Keep the cache bounded independently of the number of workspaces.
const recentExplorerViews = new Map<string, ExplorerView>()

export const FileExplorer: React.FC<FileExplorerProps> = ({ rootPath, workspaceId, panelId, scopeControl, onOpenFiles, compact = false }) => {
  const [nodes, setNodes] = useState<FileTreeNodeType[]>([])
  const [isLoading, setIsLoading] = useState(false)
  // Expansion state is owned by the explorer (not each FileTreeNode) so this
  // component knows the tree's full visible structure — needed for keyboard
  // navigation (issue #268) and as the ordering source for shift-click ranges.
  //  - expandedPaths: directory paths the user has expanded.
  //  - childrenCache: each loaded directory's children (one fsReadDir level),
  //    keyed by stable path so it survives root re-renders. Re-read on reload by
  //    the refresh queue so a move/create/delete reflects on-disk state
  //    instead of showing stale children (e.g. a moved file lingering as a copy).
  //  - loadingPaths: directories currently being read (drives the "…" spinner).
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [childrenCache, setChildrenCache] = useState<Map<string, FileTreeNodeType[]>>(new Map())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [rootCreating, setRootCreating] = useState<'file' | 'folder' | null>(null)
  const [rootCreateValue, setRootCreateValue] = useState('')
  const [createRequest, setCreateRequest] = useState<{ type: 'file' | 'folder'; targetDir: string; seq: number } | null>(null)
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const rootCreateInputRef = useRef<HTMLInputElement>(null)
  const lastSelectedPath = useRef<string | null>(null)
  const treeContainerRef = useRef<HTMLDivElement>(null)
  const virtualRowsRef = useRef<VirtualFileRowsHandle>(null)
  const [editingPaths, setEditingPaths] = useState<Set<string>>(new Set())
  const onEditingChange = useCallback((path: string, editing: boolean) => {
    setEditingPaths((previous) => {
      if (previous.has(path) === editing) return previous
      const next = new Set(previous)
      if (editing) next.add(path); else next.delete(path)
      return next
    })
  }, [])

  const rootPathRef = useRef(rootPath)
  const childrenCacheRef = useRef(childrenCache)
  const childRequests = useRef(new Map<string, Promise<void>>())
  childrenCacheRef.current = childrenCache
  const refreshRef = useRef<ReturnType<typeof createExplorerRefresh<FileTreeNodeType[]>> | null>(null)
  const createSeqRef = useRef(0)

  const selectedWorkspaceId = useAppStore((s) => workspaceId ?? s.selectedWorkspaceId)

  // Git decorations come from the single per-workspace gitStatusStore (one
  // fsWatch + focus + branch-update loop shared with the Search view and Source
  // Control), not a per-Explorer fetch. The store owns the git tint snapshot so
  // the Explorer can no longer disagree with the other git surfaces.
  const gitTree = useGitTreeFor(rootPath)

  const createTerminal = useAppStore((s) => s.createTerminal)

  const openSearch = useCallback(() => {
    setSearchVisible(true)
    setTimeout(() => searchInputRef.current?.focus(), 0)
  }, [])

  // ---------------------------------------------------------------------------
  // Name filter (inline Explorer search) — see the comment on `filter` below.
  // ---------------------------------------------------------------------------
  const filterQuery = searchQuery.trim().toLowerCase()
  const isFiltering = filterQuery.length > 0

  // Name-only filter over the *already-loaded* model (childrenCache). VS Code
  // "filter on type": a node shows when its own name matches the query, when it
  // is an ancestor of a match, or when it is any descendant under a folder that
  // itself matches. We never eagerly read the whole tree — only loaded folders
  // can be filtered (matches inside unopened folders won't appear until opened).
  //
  // We compute two things in one walk:
  //  - `visible`: the set of paths to render (passed down as a predicate).
  //  - `forceExpand`: ancestors of matches, force-expanded while filtering so the
  //    matches are actually on screen even if the user hadn't opened them.
  const filter = useMemo(() => {
    if (!isFiltering) return null
    const visible = new Set<string>()
    const forceExpand = new Set<string>()

    // Returns true if `node` (or any visible descendant) should be shown.
    // `underMatch` is true when an ancestor folder already matched — then every
    // descendant is shown wholesale.
    const walk = (node: FileTreeNodeType, underMatch: boolean): boolean => {
      const selfMatch = node.name.toLowerCase().includes(filterQuery)
      const kids = node.isDirectory ? (childrenCache.get(node.path) ?? []) : []
      let descendantVisible = false
      const propagateMatch = underMatch || selfMatch
      for (const child of kids) {
        if (walk(child, propagateMatch)) descendantVisible = true
      }
      const show = selfMatch || underMatch || descendantVisible
      if (show) {
        visible.add(node.path)
        // Force-expand a folder when one of its descendants matched (so the match
        // is reachable). A folder that only matches by its own name stays as the
        // user left it.
        if (node.isDirectory && (descendantVisible || underMatch)) forceExpand.add(node.path)
      }
      return show
    }

    for (const n of nodes) walk(n, false)
    return { visible, forceExpand }
  }, [isFiltering, filterQuery, nodes, childrenCache])

  // Effective expansion: while filtering, union the user's expansion with the
  // ancestors of matches so matches are visible without permanently mutating
  // expandedPaths (clearing the filter restores the user's own expansion).
  const effectiveExpanded = useMemo(() => {
    if (!filter) return expandedPaths
    const merged = new Set(expandedPaths)
    for (const p of filter.forceExpand) merged.add(p)
    return merged
  }, [filter, expandedPaths])


  // Flat, top-to-bottom list of every visible row: root nodes plus the children
  // of each expanded folder. Drives keyboard navigation and shift-click ranges.
  // Uses effectiveExpanded (filter-aware) and skips rows hidden by the filter so
  // keyboard nav matches exactly what's on screen.
  const flatRows = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = []
    const walk = (list: FileTreeNodeType[], depth: number, parentPath: string | null) => {
      for (const n of list) {
        if (filter && !filter.visible.has(n.path)) continue
        out.push({ path: n.path, depth, isDirectory: n.isDirectory, parentPath, node: n })
        if (n.isDirectory && effectiveExpanded.has(n.path)) {
          const kids = childrenCache.get(n.path)
          if (kids) walk(kids, depth + 1, n.path)
        }
      }
    }
    walk(nodes, 0, null)
    return out
  }, [nodes, effectiveExpanded, childrenCache, filter])

  const flatPaths = useMemo(() => flatRows.map((row) => row.path), [flatRows])

  const flatIndexByPath = useMemo(
    () => new Map(flatRows.map((r, i) => [r.path, i] as const)),
    [flatRows],
  )

  // ---------------------------------------------------------------------------
  // Expansion controls (lifted out of FileTreeNode)
  // ---------------------------------------------------------------------------

  // Lazily read a directory's children into the cache (one fsReadDir level).
  const ensureChildrenLoaded = useCallback((path: string): Promise<void> => {
    if (childrenCacheRef.current.has(path)) return Promise.resolve()
    const pending = childRequests.current.get(path)
    if (pending) return pending
    const refresh = refreshRef.current
    if (!refresh) return Promise.resolve()
    setLoadingPaths((previous) => new Set(previous).add(path))
    const request = refresh.request(path).finally(() => {
      if (refreshRef.current !== refresh) return
      childRequests.current.delete(path)
      setLoadingPaths((previous) => {
        const next = new Set(previous); next.delete(path); return next
      })
    })
    childRequests.current.set(path, request)
    return request
  }, [])

  const expand = useCallback(async (path: string) => {
    setExpandedPaths((s) => (s.has(path) ? s : new Set(s).add(path)))
    await ensureChildrenLoaded(path)
  }, [ensureChildrenLoaded])

  const collapse = useCallback((path: string) => {
    setExpandedPaths((s) => {
      if (!s.has(path)) return s
      const n = new Set(s)
      n.delete(path)
      return n
    })
  }, [])

  const toggleExpand = useCallback((path: string) => {
    if (expandedPaths.has(path)) collapse(path)
    else void expand(path)
  }, [expandedPaths, expand, collapse])

  // All filesystem-triggered reads share one queue. Preserve untouched cache
  // entries so unrelated branches retain their identities.
  const viewRef = useRef<ExplorerView>({ nodes, children: childrenCache, expanded: expandedPaths, selected: selectedPaths })
  useEffect(() => {
    rootPathRef.current = rootPath
    const cacheKey = `${selectedWorkspaceId}:${rootPath}`
    const cached = recentExplorerViews.get(cacheKey)
    childRequests.current.clear()
    setNodes(cached?.nodes ?? [])
    setChildrenCache(cached?.children ?? new Map())
    childrenCacheRef.current = cached?.children ?? new Map()
    setExpandedPaths(cached?.expanded ?? new Set())
    setSelectedPaths(cached?.selected ?? new Set())
    setLoadingPaths(new Set())
    if (!rootPath || !window.electronAPI) return
    let disposed = false
    setIsLoading(!cached)
    const refresh = createExplorerRefresh<FileTreeNodeType[]>({
      root: rootPath,
      loaded: () => [...childrenCacheRef.current.keys(), ...childRequests.current.keys()],
      read: async (path) => {
        for (let attempt = 0; ; attempt++) {
          try {
            perfCount('explorerDirectoryRead')
            if (disposed) return []
            return await window.electronAPI.fsReadDir(path, selectedWorkspaceId)
          } catch (error) {
            if (disposed || path !== rootPath || attempt >= FS_READ_RETRIES) throw error
            await new Promise<void>((resolve) => setTimeout(resolve, FS_READ_RETRY_DELAY_MS))
          }
        }
      },
      apply: (path, entries) => {
        if (path === rootPath) { setNodes(entries ?? []); setIsLoading(false) }
        else setChildrenCache((previous) => {
          const next = new Map(previous)
          if (entries) next.set(path, entries)
          else next.delete(path)
          childrenCacheRef.current = next
          return next
        })
        if (!entries) setExpandedPaths((previous) => {
          if (!previous.has(path)) return previous
          const next = new Set(previous); next.delete(path); return next
        })
      },
      remove: (path) => {
        const normalized = path.replace(/\\/g, '/')
        const under = (key: string) => {
          const value = key.replace(/\\/g, '/')
          return value === normalized || value.startsWith(normalized + '/')
        }
        setChildrenCache((previous) => new Map([...previous].filter(([key]) => !under(key))))
        setExpandedPaths((previous) => new Set([...previous].filter((key) => !under(key))))
      },
    })
    refreshRef.current = refresh
    void refresh.request(rootPath)
    if (cached) refresh.refresh(cached.children.keys())
    const releaseWatch = watchFsRoot(rootPath, refresh.event, selectedWorkspaceId)
    return () => {
      recentExplorerViews.delete(cacheKey)
      recentExplorerViews.set(cacheKey, viewRef.current)
      while (recentExplorerViews.size > 2) recentExplorerViews.delete(recentExplorerViews.keys().next().value!)
      disposed = true
      refresh.dispose()
      refreshRef.current = null
      releaseWatch()
    }
  }, [rootPath, selectedWorkspaceId])
  useEffect(() => {
    viewRef.current = { nodes, children: childrenCache, expanded: expandedPaths, selected: selectedPaths }
  }, [nodes, childrenCache, expandedPaths, selectedPaths])

  const loadTree = useCallback((_dirPath: string) => {
    refreshRef.current?.refresh([rootPath, ...childrenCacheRef.current.keys()])
  }, [rootPath])

  // Inline Explorer search is a lightweight name-only tree filter ("filter on
  // type"). Full content search now lives in the dedicated Search view.

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleSelect = useCallback(
    (path: string, meta: { shift?: boolean; cmd?: boolean }) => {
      // Shift-range needs the paths in their actual on-screen order. flatRows is
      // exactly that — every visible row, top to bottom, including the children
      // of expanded folders.
      const order = flatRows.map((r) => r.path)
      setSelectedPaths((prev) => {
        if (meta.cmd) {
          // Toggle individual selection
          const next = new Set(prev)
          if (next.has(path)) {
            next.delete(path)
          } else {
            next.add(path)
          }
          lastSelectedPath.current = path
          return next
        }
        if (meta.shift && lastSelectedPath.current) {
          // Range selection across the visible rows (anchor → clicked).
          const startIdx = order.indexOf(lastSelectedPath.current)
          const endIdx = order.indexOf(path)
          if (startIdx !== -1 && endIdx !== -1) {
            const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
            const next = new Set(prev)
            for (let i = lo; i <= hi; i++) {
              next.add(order[i])
            }
            // Keep the anchor where it was so a second shift-click re-ranges
            // from the same origin (matches Finder/VS Code behavior).
            return next
          }
        }
        // Plain click — select only this
        lastSelectedPath.current = path
        return new Set([path])
      })
      // Move keyboard focus into the tree so Delete/Backspace is handled here.
      // The rows are draggable <div>s, which don't reliably take focus on click,
      // so focus the (tabbable) scroll container explicitly. preventScroll keeps
      // the list from jumping when a row deep in the tree is clicked.
      treeContainerRef.current?.focus({ preventScroll: true })
      if (onOpenFiles && !meta.shift && !meta.cmd && flatRows.some((row) => row.path === path && !row.isDirectory)) {
        onOpenFiles([path])
      }
    },
    [flatRows, onOpenFiles],
  )

  // Move the keyboard cursor to a single row: select it and scroll it into view.
  const moveCursorTo = useCallback((path: string) => {
    setSelectedPaths(new Set([path]))
    lastSelectedPath.current = path
    virtualRowsRef.current?.reveal(path)
  }, [])

  const handleFileOpen = useCallback(
    (filePaths: string[], mode?: 'dock' | 'canvas') => {
      if (onOpenFiles) {
        onOpenFiles(filePaths, mode)
        return
      }
      // Resolve mode: explicit > infer from active center panel
      // Default: always open as a dock tab in the center zone (alongside the
      // canvas tab). Opening as a floating canvas node requires an explicit
      // 'canvas' mode from the context menu.
      const resolved = mode ?? 'dock'
      const placement = resolved === 'canvas'
        ? undefined
        : { target: 'dock' as const, zone: 'center' as const }
      for (const filePath of filePaths) {
        openFileAsPanel(selectedWorkspaceId, filePath, undefined, placement)
      }
    },
    [onOpenFiles, selectedWorkspaceId],
  )

  const handleReload = useCallback(() => {
    if (rootPath) loadTree(rootPath)
  }, [rootPath, loadTree])

  // Delete one or many paths in a single confirm (used by both the
  // Cmd+Backspace / Delete keyboard shortcut and the right-click menu, so a
  // multi-selection is removed all at once rather than one file per action).
  const deletePaths = useCallback(async (paths: string[]) => {
    if (!window.electronAPI || paths.length === 0) return
    const label = paths.length === 1
      ? `"${pathDisplayName(paths[0])}"`
      : `${paths.length} items`
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return
    for (const p of paths) {
      try {
        await window.electronAPI.fsDelete(p, selectedWorkspaceId)
      } catch (err) {
        console.error('[file-explorer] Failed to delete entry:', err)
      }
    }
    setSelectedPaths(new Set())
    handleReload()
  }, [handleReload, selectedWorkspaceId])

  const handleTreeKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Inline rename/create inputs handle their own keys.
    if (e.target instanceof HTMLInputElement) return

    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPaths.size > 0) {
      e.preventDefault()
      void deletePaths([...selectedPaths])
      return
    }

    // VS Code-style tree navigation (issue #268). Only plain (unmodified) arrow/
    // Enter keys act here — Cmd+Arrow (canvas navigate) and Shift+Arrow (canvas
    // pan) are claimed by the global capture-phase handler before they reach us,
    // and bailing on any modifier keeps the explorer from ever stealing them.
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    if (!isNavKey(e.key)) return

    const activePath = selectedPaths.size === 1 ? [...selectedPaths][0] : null
    const action = resolveTreeNavAction(e.key, flatRows, activePath, (p) => effectiveExpanded.has(p))
    if (!action) {
      // Still swallow the key (e.g. Right on a file) so the scroll container
      // doesn't scroll instead.
      if (flatRows.length > 0) e.preventDefault()
      return
    }
    e.preventDefault()
    switch (action.type) {
      case 'move': moveCursorTo(action.path); break
      case 'expand': void expand(action.path); break
      case 'collapse': collapse(action.path); break
      case 'toggle': toggleExpand(action.path); break
      case 'open': handleFileOpen([action.path], 'dock'); break
    }
  }, [
    selectedPaths, deletePaths, flatRows,
    effectiveExpanded, expand, collapse, toggleExpand, handleFileOpen, moveCursorTo,
  ])

  // Resolve the target directory for new file/folder creation based on selection
  const getSelectedDir = useCallback((): string | null => {
    if (selectedPaths.size !== 1) return null
    const selectedPath = [...selectedPaths][0]
    const row = flatRows[flatIndexByPath.get(selectedPath) ?? -1]
    if (row) {
      return row.isDirectory ? row.path : row.path.substring(0, row.path.lastIndexOf('/'))
    }
    // Selected row isn't currently visible — fall back to its parent dir.
    const slash = selectedPath.lastIndexOf('/')
    return slash > 0 ? selectedPath.substring(0, slash) : rootPath
  }, [selectedPaths, flatRows, flatIndexByPath, rootPath])

  const startRootCreate = useCallback((type: 'file' | 'folder') => {
    const targetDir = getSelectedDir()
    if (targetDir && targetDir !== rootPath) {
      // Delegate creation to the selected folder's FileTreeNode
      virtualRowsRef.current?.reveal(targetDir)
      createSeqRef.current++
      setCreateRequest({ type, targetDir, seq: createSeqRef.current })
    } else {
      // No folder selected or root — create at root level
      setRootCreateValue('')
      setRootCreating(type)
      setTimeout(() => rootCreateInputRef.current?.focus(), 0)
    }
  }, [getSelectedDir, rootPath])

  const commitRootCreate = useCallback(async () => {
    const type = rootCreating
    setRootCreating(null)
    const trimmed = rootCreateValue.trim()
    if (!trimmed || !window.electronAPI || !type) return
    const newPath = rootPath + '/' + trimmed
    try {
      if (type === 'folder') {
        await window.electronAPI.fsMkdir(newPath, selectedWorkspaceId)
      } else {
        await window.electronAPI.fsWriteFile(newPath, '', selectedWorkspaceId)
      }
      loadTree(rootPath)
    } catch (err) {
      console.error('[file-explorer] Failed to create entry:', err)
    }
  }, [rootCreating, rootCreateValue, rootPath, loadTree, selectedWorkspaceId])

  const folderName = workspaceDisplayName(rootPath) || 'Explorer'

  const handleRootContextMenu = useCallback(async (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    if (!window.electronAPI) return
    const id = await window.electronAPI.showContextMenu([
      { id: 'new-file', label: 'New File…' },
      { id: 'new-folder', label: 'New Folder…' },
      { type: 'separator' },
      // Reveal opens the LOCAL Finder — omitted for a remote workspace root
      // instead of silently no-oping.
      ...(isLocalLocator(rootPath)
        ? [{ id: 'reveal', label: 'Reveal in Finder', accelerator: 'Alt+Cmd+R' }]
        : []),
      { id: 'open-terminal', label: 'Open in Integrated Terminal' },
      { type: 'separator' },
      { id: 'paste', label: 'Paste', accelerator: 'Cmd+V', enabled: hasClipboard() },
      { type: 'separator' },
      { id: 'find-in-folder', label: 'Find in Folder…', accelerator: 'Alt+Shift+F' },
      { type: 'separator' },
      { id: 'copy-path', label: 'Copy Path', accelerator: 'Alt+Cmd+C' },
      { id: 'copy-rel-path', label: 'Copy Relative Path', accelerator: 'Alt+Shift+Cmd+C' },
    ])
    switch (id) {
      case 'new-file': startRootCreate('file'); break
      case 'new-folder': startRootCreate('folder'); break
      case 'reveal': window.electronAPI.shellShowInFolder(rootPath, selectedWorkspaceId); break
      case 'open-terminal':
        {
          const store = useAppStore.getState()
          const workspace = store.getWorkspace(selectedWorkspaceId)
          const worktree = worktreeForPath(rootPath, workspace?.worktrees ?? [])
          const terminalId = createTerminal(
            selectedWorkspaceId,
            undefined,
            undefined,
            panelId ? placementForPanel(selectedWorkspaceId, panelId) : undefined,
            rootPath,
          )
          if (terminalId && worktree) store.setPanelWorktreeId(selectedWorkspaceId, terminalId, worktree.id)
        }
        break
      case 'paste': {
        const sources = getClipboard()
        for (const src of sources) {
          try {
            await window.electronAPI.fsCopy(src, rootPath, selectedWorkspaceId)
          } catch (err) {
            console.error('[file-explorer] Paste failed:', err)
          }
        }
        handleReload()
        break
      }
      case 'find-in-folder': openSearch(); break
      case 'copy-path': navigator.clipboard.writeText(rootPath); break
      case 'copy-rel-path': navigator.clipboard.writeText(folderName); break
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, startRootCreate, createTerminal, selectedWorkspaceId, panelId, openSearch])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className="file-explorer flex flex-col h-full"
      // External (OS) file/folder drops anywhere in the panel import into the
      // workspace root. stopPropagation keeps the drop from bubbling to the
      // app-root handler (which would otherwise re-root the workspace).
      onDragOver={(e) => {
        if (!isExternalFileDrag(e)) return
        e.preventDefault()
        // Stop the bubble to the app-root dragover handler, which forces
        // dropEffect='none' (to swallow stray canvas drops) and would otherwise
        // override our 'copy' and make the browser reject the drop.
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(e) => {
        if (!isExternalFileDrag(e)) return
        e.preventDefault()
        e.stopPropagation()
        const files = e.dataTransfer.files
        void importDroppedEntries(files, rootPath, folderName, selectedWorkspaceId).then((ok) => {
          if (ok) handleReload()
        })
      }}
    >
      {!compact && <SidebarSectionHeader
        title="Explorer"
        subtitle={scopeControl ?? folderName}
        actions={
          <>
            <SidebarHeaderButton onClick={() => startRootCreate('file')} title="New File">
              <FilePlus size={13} />
            </SidebarHeaderButton>
            <SidebarHeaderButton onClick={() => startRootCreate('folder')} title="New Folder">
              <FolderPlus size={13} />
            </SidebarHeaderButton>
            <SidebarHeaderButton
              onClick={() => {
                setSearchVisible((v) => {
                  const next = !v
                  if (next) setTimeout(() => searchInputRef.current?.focus(), 0)
                  else setSearchQuery('')
                  return next
                })
              }}
              title="Filter Files"
            >
              <MagnifyingGlass size={13} />
            </SidebarHeaderButton>
            <SidebarHeaderButton onClick={handleReload} title="Reload">
              <ArrowClockwise size={12} />
            </SidebarHeaderButton>
          </>
        }
      />}

      {compact && (
        <div className="h-10 shrink-0 px-2 flex items-center gap-1">
          <div className="flex-1 min-w-0 relative">
            <MagnifyingGlass size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Filter files"
              className="w-full bg-surface-2 text-primary text-xs pl-7 pr-2 py-1.5 rounded-lg border border-subtle focus:border-focus outline-none"
            />
          </div>
          <div className="shrink-0 flex items-center gap-1">
            <SidebarHeaderButton onClick={() => startRootCreate('file')} title="New File"><FilePlus size={14} /></SidebarHeaderButton>
            <SidebarHeaderButton onClick={() => startRootCreate('folder')} title="New Folder"><FolderPlus size={14} /></SidebarHeaderButton>
            <SidebarHeaderButton onClick={handleReload} title="Reload"><ArrowClockwise size={14} /></SidebarHeaderButton>
          </div>
        </div>
      )}

      {!compact && searchVisible && (
        <div className="px-2 py-1.5 border-b border-subtle flex items-center gap-1">
          <div className="flex-1 relative">
            <MagnifyingGlass
              size={11}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearchQuery('')
                  setSearchVisible(false)
                }
                e.stopPropagation()
              }}
              placeholder="Filter by name"
              className="w-full bg-surface-2 text-primary text-xs pl-7 pr-2 py-1 rounded-lg border border-subtle focus:border-focus outline-none"
            />
          </div>
          {searchQuery && (
            <SidebarHeaderButton
              onClick={() => setSearchQuery('')}
              title="Clear"
            >
              <X size={12} />
            </SidebarHeaderButton>
          )}
        </div>
      )}

      {/* Tree content */}
      {isLoading && nodes.length === 0 ? (
        <LoadingState label="Loading files…" size={14} className="flex-1 text-xs" />
      ) : nodes.length === 0 && !rootCreating ? (
        <div
          className="flex flex-col items-center justify-center flex-1 text-muted text-xs gap-2 p-4"
          onContextMenu={handleRootContextMenu}
        >
          <span className="text-2xl pointer-events-none">&#128193;</span>
          <span className="pointer-events-none">No files found</span>
        </div>
      ) : (
        <div
          ref={treeContainerRef}
          className="relative flex-1 overflow-y-auto py-1 outline-none"
          // Focusable + tagged so Delete/Backspace (incl. Cmd+Backspace) deletes
          // the selection here instead of being swallowed by the canvas-level
          // shortcut handler. Focused explicitly from onSelect (draggable rows
          // don't reliably focus this container on click).
          tabIndex={-1}
          data-sidebar-keynav
          onKeyDown={handleTreeKeyDown}
          onClick={(e) => {
            // Click on empty area clears selection
            if (e.target === e.currentTarget) setSelectedPaths(new Set())
          }}
          onContextMenu={handleRootContextMenu}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('application/cate-file')) {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
            }
          }}
          onDrop={async (e) => {
            e.preventDefault()
            if (!window.electronAPI) return
            const raw = e.dataTransfer.getData('application/cate-files')
            if (!raw) return
            const sourcePaths: string[] = JSON.parse(raw)
            for (const srcPath of sourcePaths) {
              const fileName = srcPath.substring(srcPath.lastIndexOf('/') + 1)
              const destPath = rootPath + '/' + fileName
              if (srcPath === destPath) continue
              try {
                await window.electronAPI.fsRename(srcPath, destPath, selectedWorkspaceId)
              } catch (err) {
                console.error('[file-explorer] Failed to move file:', err)
              }
            }
            handleReload()
          }}
        >
          {isFiltering && flatRows.length === 0 ? (
            <div className="flex items-center justify-center py-4 text-xs text-muted">No matches</div>
          ) : (
            <VirtualFileRows
              ref={virtualRowsRef}
              scrollRef={treeContainerRef}
              paths={flatPaths}
              pinned={new Set([...editingPaths, ...(createRequest ? [createRequest.targetDir] : [])])}
              renderRow={(index) => {
                const { node, depth } = flatRows[index]
                return <FileTreeNode
                  key={node.path}
                  flat
                  onEditingChange={onEditingChange}
                  node={node}
                  depth={depth}
                  git={gitTree}
                  selectedPaths={selectedPaths}
                  expandedPaths={effectiveExpanded}
                  childrenCache={childrenCache}
                  loadingPaths={loadingPaths}
                  onSelect={handleSelect}
                  onFileOpen={handleFileOpen}
                  onToggleExpand={toggleExpand}
                  onExpand={expand}
                  onDeletePaths={deletePaths}
                  onTreeChanged={handleReload}
                  rootPath={rootPath}
                  workspaceId={selectedWorkspaceId}
                  createRequest={createRequest}
                  onCreateRequestHandled={() => setCreateRequest(null)}
                />
              }}
            />
          )}

          {/* Inline create input for root-level creation (from empty space context menu) */}
          {rootCreating && (
            <CreateFileForm
              ref={rootCreateInputRef}
              type={rootCreating}
              value={rootCreateValue}
              onChange={setRootCreateValue}
              onSubmit={commitRootCreate}
              onCancel={() => setRootCreating(null)}
              paddingLeft="8px"
            />
          )}
        </div>
      )}
    </div>
  )
}
