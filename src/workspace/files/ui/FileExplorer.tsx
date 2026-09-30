// =============================================================================
// FileExplorer — Git-aware file tree browser.
// Ported from FileExplorerView.swift + FileTreeModel.swift
// =============================================================================

import React, { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { RotateCw as ArrowClockwise, FilePlus, FolderPlus, Search as MagnifyingGlass, X } from 'lucide-react'
import { clientUi, LoadingState, SidebarSectionHeader, SidebarHeaderButton } from '@kernel/ui'
import { pathDisplayName, type FileEntry as FileTreeNodeType } from '../contract'
import { VirtualFileRows, type VirtualFileRowsHandle } from './VirtualFileRows'
import type { FileTreeModel } from './fileTreeModel'
import type { ContextMenuItem } from '@kernel/ui/contract'
import { useFileViewsHost } from './FileViewsContext'
import { FileTreeNode } from './FileTreeNode'
import { CreateFileForm } from './CreateFileForm'
import { isNavKey, resolveTreeNavAction } from './treeKeyboardNav'
import { useGitTree } from './gitTree'
import { getClipboard, hasClipboard } from './fileClipboard'
import { isExternalFileDrag, takeDroppedItems } from './droppedEntries'

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export interface FileExplorerProps {
  resource: FileTreeModel
  workspaceId: string
  /** The panel showing the explorer; new terminals are placed next to it. */
  panelId?: string
  rootPath: string
  scopeControl?: React.ReactNode
  /** Opens files itself (a single click on a file opens it too); without it
   *  files open as panels through the FileViewsContext host. */
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

export const FileExplorer: React.FC<FileExplorerProps> = ({ resource, rootPath, workspaceId, panelId, scopeControl, onOpenFiles, compact = false }) => {
  const { nodes, childrenCache, expandedPaths, selectedPaths, loadingPaths, isLoading, loadError } = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot)
  const { setExpandedPaths, setSelectedPaths, ensureChildrenLoaded } = resource
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

  const createSeqRef = useRef(0)

  const selectedWorkspaceId = workspaceId
  const host = useFileViewsHost()

  // Git decorations come from the workspace's shared git status store (one
  // status stream per checkout, shared with the Search view and Source
  // Control), so the Explorer can not disagree with the other git surfaces.
  const gitTree = useGitTree(workspaceId, rootPath)

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

  const expand = useCallback(async (path: string) => {
    setExpandedPaths((s) => (s.has(path) ? s : new Set(s).add(path)))
    await ensureChildrenLoaded(path)
  }, [ensureChildrenLoaded, setExpandedPaths])

  const collapse = useCallback((path: string) => {
    setExpandedPaths((s) => {
      if (!s.has(path)) return s
      const n = new Set(s)
      n.delete(path)
      return n
    })
  }, [setExpandedPaths])

  const toggleExpand = useCallback((path: string) => {
    if (expandedPaths.has(path)) collapse(path)
    else void expand(path)
  }, [expandedPaths, expand, collapse])

  const loadTree = useCallback((_dirPath: string) => resource.refresh(), [resource])

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
    [flatRows, onOpenFiles, setSelectedPaths],
  )

  // Move the keyboard cursor to a single row: select it and scroll it into view.
  const moveCursorTo = useCallback((path: string) => {
    setSelectedPaths(new Set([path]))
    lastSelectedPath.current = path
    virtualRowsRef.current?.reveal(path)
  }, [setSelectedPaths])

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
      host.openFiles(selectedWorkspaceId, filePaths, mode ?? 'dock')
    },
    [onOpenFiles, selectedWorkspaceId, host],
  )

  const handleReload = useCallback(() => {
    if (rootPath) loadTree(rootPath)
  }, [rootPath, loadTree])

  // Delete one or many paths in a single confirm (used by both the
  // Cmd+Backspace / Delete keyboard shortcut and the right-click menu, so a
  // multi-selection is removed all at once rather than one file per action).
  const deletePaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return
    const label = paths.length === 1
      ? `"${pathDisplayName(paths[0])}"`
      : `${paths.length} items`
    if (!await clientUi().confirm(`Delete ${label}? This cannot be undone.`)) return
    for (const p of paths) {
      try {
        await resource.delete(p)
      } catch (err) {
        console.error('[file-explorer] Failed to delete entry:', err)
      }
    }
    setSelectedPaths(new Set())
    handleReload()
  }, [handleReload, resource, setSelectedPaths])

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
    if (!trimmed || !type) return
    const newPath = rootPath + '/' + trimmed
    try {
      await resource.create(newPath, type)
      loadTree(rootPath)
    } catch (err) {
      console.error('[file-explorer] Failed to create entry:', err)
    }
  }, [rootCreating, rootCreateValue, rootPath, loadTree, resource])

  const folderName = pathDisplayName(rootPath) || 'Explorer'

  const handleRootContextMenu = useCallback(async (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    const ui = clientUi()
    if (!ui.showContextMenu) return
    const items: ContextMenuItem[] = [
      { id: 'new-file', label: 'New File…' },
      { id: 'new-folder', label: 'New Folder…' },
      { type: 'separator' },
      // Only a client with OS file actions can reveal; otherwise the item is
      // omitted instead of silently no-oping.
      ...(ui.revealFile
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
    ]
    const id = await ui.showContextMenu(items)
    switch (id) {
      case 'new-file': startRootCreate('file'); break
      case 'new-folder': startRootCreate('folder'); break
      case 'reveal': void ui.revealFile?.(rootPath, selectedWorkspaceId); break
      // The terminal binds the worktree containing rootPath.
      case 'open-terminal': host.openTerminal(selectedWorkspaceId, rootPath, panelId); break
      case 'paste': {
        const sources = getClipboard()
        for (const src of sources) {
          try {
            await resource.copy(src, rootPath)
          } catch (err) {
            console.error('[file-explorer] Paste failed:', err)
          }
        }
        handleReload()
        break
      }
      case 'find-in-folder': openSearch(); break
      case 'copy-path': void ui.writeClipboard?.(rootPath); break
      case 'copy-rel-path': void ui.writeClipboard?.(folderName); break
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, startRootCreate, selectedWorkspaceId, panelId, openSearch, host])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className="file-explorer flex flex-col h-full min-h-0 overflow-hidden"
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
        const dropped = takeDroppedItems(e.dataTransfer)
        void resource.importDropped(dropped, rootPath, folderName).then((ok) => {
          if (ok) handleReload()
        })
      }}
    >
      {!compact && <SidebarSectionHeader
        title="Explorer"
        subtitle={scopeControl ?? folderName}
        actions={
          <>
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

      {loadError && (
        <div role="alert" className="shrink-0 px-3 py-3 text-xs text-muted">
          <p className="font-medium text-primary">Could not load files</p>
          <p className="mt-1 break-words">{loadError}</p>
          <button type="button" className="mt-2 rounded-md bg-surface-2 px-3 py-1.5 text-primary hover:bg-hover" onClick={() => void resource.retry()}>Retry</button>
        </div>
      )}
      {/* Tree content */}
      {isLoading && nodes.length === 0 ? (
        <LoadingState label="Loading files…" size={14} className="flex-1 text-xs" />
      ) : nodes.length === 0 && loadError && !rootCreating ? null : nodes.length === 0 && !rootCreating ? (
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
          className="relative flex-1 min-h-0 overflow-y-auto overscroll-none pt-1 pb-4 outline-none"
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
            const raw = e.dataTransfer.getData('application/cate-files')
            if (!raw) return
            const sourcePaths: string[] = JSON.parse(raw)
            for (const srcPath of sourcePaths) {
              const fileName = srcPath.substring(srcPath.lastIndexOf('/') + 1)
              const destPath = rootPath + '/' + fileName
              if (srcPath === destPath) continue
              try {
                await resource.rename(srcPath, destPath)
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
                  resource={resource}
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
      <div className="relative shrink-0 h-10 flex items-center justify-end gap-1 px-2">
        <div className="pointer-events-none absolute inset-x-0 -top-4 h-4" style={{ background: 'linear-gradient(to bottom, transparent, var(--file-explorer-bg, var(--surface-1)))' }} />
        <SidebarHeaderButton onClick={() => startRootCreate('file')} title="New File"><FilePlus size={14} /></SidebarHeaderButton>
        <SidebarHeaderButton onClick={() => startRootCreate('folder')} title="New Folder"><FolderPlus size={14} /></SidebarHeaderButton>
      </div>
    </div>
  )
}
