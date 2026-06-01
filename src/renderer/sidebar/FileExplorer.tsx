// =============================================================================
// FileExplorer — Git-aware file tree browser.
// Ported from FileExplorerView.swift + FileTreeModel.swift
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import log from '../lib/logger'
import { ArrowClockwise, FilePlus, FolderPlus, MagnifyingGlass, X, Folder, File } from '@phosphor-icons/react'
import type { FileTreeNode as FileTreeNodeType, FileSearchResult } from '../../shared/types'
import { FileTreeNode } from './FileTreeNode'
import { buildGitTreeDecorations, folderColorClass, lookupNodeDecoration, toPosixPath, type GitTree } from './gitStatusDecoration'
import { getClipboard, hasClipboard } from './fileClipboard'
import { useAppStore } from '../stores/appStore'
import { useDockStore } from '../stores/dockStore'
import { openFileAsPanel } from '../lib/fileRouting'
import { isExternalFileDrag, importDroppedEntries } from '../lib/importExternalEntries'
import { SidebarSectionHeader, SidebarHeaderButton } from './SidebarSectionHeader'
import type { DockLayoutNode } from '../../shared/types'

// Opening a workspace sets its root path optimistically in the renderer, but
// main only registers that path as an allowed root once the async workspace
// sync resolves. A read issued before then is rejected (it throws, rather than
// returning [] like a genuinely empty directory), so retry a few times to ride
// out that race instead of leaving the tree stuck empty until a manual reload.
const FS_READ_RETRIES = 5
const FS_READ_RETRY_DELAY_MS = 120

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function findActivePanel(node: DockLayoutNode): string | null {
  if (node.type === 'tabs') return node.panelIds[node.activeIndex] ?? null
  for (const child of node.children) {
    const result = findActivePanel(child)
    if (result) return result
  }
  return null
}

function isCanvasActiveInCenter(): boolean {
  const centerLayout = useDockStore.getState().zones.center.layout
  if (!centerLayout) return false
  const activePanelId = findActivePanel(centerLayout)
  if (!activePanelId) return false
  const appState = useAppStore.getState()
  const ws = appState.workspaces.find((w) => w.id === appState.selectedWorkspaceId)
  return ws?.panels[activePanelId]?.type === 'canvas'
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

interface FileExplorerProps {
  rootPath: string
}

export const FileExplorer: React.FC<FileExplorerProps> = ({ rootPath }) => {
  const [nodes, setNodes] = useState<FileTreeNodeType[]>([])
  const [isLoading, setIsLoading] = useState(false)
  // Bumped on every successful tree read. Nested folders cache their own
  // children in local state (keyed by stable path, so they survive a root
  // re-render); this signal tells each cached/expanded folder to re-read from
  // disk so a reload — or a move/create/delete — actually reflects on-disk state
  // instead of showing stale children (e.g. a moved file lingering in its old
  // folder, which reads as a copy).
  const [refreshSignal, setRefreshSignal] = useState(0)
  const [gitTree, setGitTree] = useState<GitTree | undefined>(undefined)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [rootCreating, setRootCreating] = useState<'file' | 'folder' | null>(null)
  const [rootCreateValue, setRootCreateValue] = useState('')
  const [createRequest, setCreateRequest] = useState<{ type: 'file' | 'folder'; targetDir: string; seq: number } | null>(null)
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<FileSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const searchSeqRef = useRef(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const rootCreateInputRef = useRef<HTMLInputElement>(null)
  const lastSelectedPath = useRef<string | null>(null)
  const treeContainerRef = useRef<HTMLDivElement>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootPathRef = useRef(rootPath)
  const createSeqRef = useRef(0)
  const loadRetryTimerRef = useRef<number | null>(null)

  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)

  const createTerminal = useAppStore((s) => s.createTerminal)
  const removeWorkspace = useAppStore((s) => s.removeWorkspace)

  const openSearch = useCallback(() => {
    setSearchVisible(true)
    setTimeout(() => searchInputRef.current?.focus(), 0)
  }, [])

  // Build flat list of visible paths for shift-click range selection
  const visiblePaths = useMemo(() => {
    const paths: string[] = []
    // We just collect top-level node paths; child visibility is managed by
    // each FileTreeNode's local expansion state, so we flatten all nodes here.
    // For shift-select we only need top-level; deeper nodes will be gathered
    // by the recursive component passing the same visiblePaths down.
    const collect = (nodeList: FileTreeNodeType[]) => {
      for (const n of nodeList) {
        paths.push(n.path)
        // Children are loaded lazily by FileTreeNode, so we can't reliably
        // enumerate them here. The shift-select will work on sibling level.
        if (n.children.length > 0) collect(n.children)
      }
    }
    collect(nodes)
    return paths
  }, [nodes])

  // ---------------------------------------------------------------------------
  // Load tree
  // ---------------------------------------------------------------------------

  const loadTree = useCallback(async (dirPath: string, attempt = 0) => {
    if (!window.electronAPI) return

    setIsLoading(true)
    try {
      const entries = await window.electronAPI.fsReadDir(dirPath)

      // Check git status. We fetch both the tracked-file list and the porcelain
      // status: the status drives per-file decorations (modified/added/deleted/
      // untracked) + folder tinting, while the tracked set lets us tell an
      // untracked-new file (decorated green) from a git-ignored one (dimmed).
      const isGit = await window.electronAPI.gitIsRepo(dirPath)
      if (isGit) {
        const [trackedFiles, status] = await Promise.all([
          window.electronAPI.gitLsFiles(dirPath),
          window.electronAPI.gitStatus(dirPath),
        ])
        // Both gitLsFiles and gitStatus return paths relative to the repo cwd;
        // convert to absolute (posix) so lookups match node.path cross-platform.
        const root = toPosixPath(dirPath)
        setGitTree({
          tracked: new Set(trackedFiles.map((p) => `${root}/${p}`)),
          decorations: buildGitTreeDecorations(status.files, dirPath),
        })
      } else {
        setGitTree(undefined)
      }

      setNodes(entries)
      // Invalidate cached children in every expanded/loaded nested folder so the
      // refreshed root read propagates the whole way down the tree.
      setRefreshSignal((n) => n + 1)
      setIsLoading(false)
    } catch (err) {
      // The read was rejected (e.g. the root path isn't registered as an allowed
      // root in main yet — see FS_READ_RETRIES note). Retry a few times before
      // giving up, but bail if the root changed underneath us in the meantime.
      if (attempt < FS_READ_RETRIES && rootPathRef.current === dirPath) {
        loadRetryTimerRef.current = window.setTimeout(
          () => loadTree(dirPath, attempt + 1),
          FS_READ_RETRY_DELAY_MS,
        )
        return
      }
      log.warn('[file-explorer] Load tree failed:', err)
      setNodes([])
      setGitTree(undefined)
      setIsLoading(false)
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Watch for filesystem changes
  // ---------------------------------------------------------------------------

  useEffect(() => {
    rootPathRef.current = rootPath

    // Clean up previous watcher
    if (cleanupRef.current) {
      cleanupRef.current()
      cleanupRef.current = null
    }

    // Cancel any in-flight load retry from a previous root.
    if (loadRetryTimerRef.current !== null) {
      window.clearTimeout(loadRetryTimerRef.current)
      loadRetryTimerRef.current = null
    }

    if (!rootPath || !window.electronAPI) return

    // Initial load
    loadTree(rootPath)

    // Start watcher
    window.electronAPI.fsWatchStart(rootPath).catch((err) => log.warn('[file-explorer] Watch start failed:', err))

    // Listen for events. Coalesce bursts (e.g. a build writing many files) with
    // a short trailing debounce so we don't re-read the tree + re-run git status
    // on every individual fs event.
    const scheduleReload = () => {
      if (rootPathRef.current !== rootPath) return
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current)
      reloadTimerRef.current = setTimeout(() => {
        reloadTimerRef.current = null
        if (rootPathRef.current === rootPath) loadTree(rootPath)
      }, 150)
    }
    const unsubscribe = window.electronAPI.onFsWatchEvent(scheduleReload)

    // Reload when the exclusions list changes so hidden/shown folders update
    // without a relaunch.
    const unsubscribeSettings = window.electronAPI.onSettingsChanged((key) => {
      if (key === 'fileExclusions' && rootPathRef.current === rootPath) {
        loadTree(rootPath)
      }
    })

    cleanupRef.current = () => {
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current)
        reloadTimerRef.current = null
      }
      unsubscribe()
      unsubscribeSettings()
      window.electronAPI?.fsWatchStop(rootPath).catch((err) => log.warn('[file-explorer] Watch stop failed:', err))
    }

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current()
        cleanupRef.current = null
      }
      if (loadRetryTimerRef.current !== null) {
        window.clearTimeout(loadRetryTimerRef.current)
        loadRetryTimerRef.current = null
      }
    }
  }, [rootPath, loadTree])

  // ---------------------------------------------------------------------------
  // Debounced file search (name + content) — runs in main process.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const trimmed = searchQuery.trim()
    if (!trimmed || !rootPath || !window.electronAPI) {
      setSearchResults([])
      setSearchLoading(false)
      return
    }
    const seq = ++searchSeqRef.current
    setSearchLoading(true)
    const handle = window.setTimeout(async () => {
      try {
        const results = await window.electronAPI.fsSearch(rootPath, trimmed)
        if (seq !== searchSeqRef.current) return
        setSearchResults(results)
      } catch (err) {
        if (seq !== searchSeqRef.current) return
        log.warn('[file-explorer] search failed:', err)
        setSearchResults([])
      } finally {
        if (seq === searchSeqRef.current) setSearchLoading(false)
      }
    }, 200)
    return () => window.clearTimeout(handle)
  }, [searchQuery, rootPath])

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleSelect = useCallback(
    (path: string, meta: { shift?: boolean; cmd?: boolean }) => {
      // Shift-range needs the paths in their actual on-screen order. visiblePaths
      // only has top-level entries (nested children live in each FileTreeNode's
      // local state), so read the rendered rows from the DOM instead — that
      // reflects exactly what's visible, including expanded sub-folders.
      const domOrder = meta.shift && treeContainerRef.current
        ? Array.from(treeContainerRef.current.querySelectorAll<HTMLElement>('[data-filepath]'))
            .map((el) => el.dataset.filepath!)
        : visiblePaths
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
          const startIdx = domOrder.indexOf(lastSelectedPath.current)
          const endIdx = domOrder.indexOf(path)
          if (startIdx !== -1 && endIdx !== -1) {
            const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
            const next = new Set(prev)
            for (let i = lo; i <= hi; i++) {
              next.add(domOrder[i])
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
    },
    [visiblePaths],
  )

  const handleFileOpen = useCallback(
    (filePaths: string[], mode?: 'dock' | 'canvas') => {
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
    [selectedWorkspaceId],
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
      ? `"${paths[0].split('/').pop()}"`
      : `${paths.length} items`
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return
    for (const p of paths) {
      try {
        await window.electronAPI.fsDelete(p)
      } catch (err) {
        console.error('[file-explorer] Failed to delete entry:', err)
      }
    }
    setSelectedPaths(new Set())
    handleReload()
  }, [handleReload])

  const handleTreeKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPaths.size > 0) {
      e.preventDefault()
      void deletePaths([...selectedPaths])
    }
  }, [selectedPaths, deletePaths])

  // Resolve the target directory for new file/folder creation based on selection
  const getSelectedDir = useCallback((): string | null => {
    if (selectedPaths.size !== 1) return null
    const selectedPath = [...selectedPaths][0]
    // Find if the selected path is a directory by searching the tree
    const findNode = (nodeList: FileTreeNodeType[]): FileTreeNodeType | null => {
      for (const n of nodeList) {
        if (n.path === selectedPath) return n
        if (n.children.length > 0) {
          const found = findNode(n.children)
          if (found) return found
        }
      }
      return null
    }
    const node = findNode(nodes)
    if (!node) return null
    return node.isDirectory ? node.path : node.path.substring(0, node.path.lastIndexOf('/'))
  }, [selectedPaths, nodes])

  const startRootCreate = useCallback((type: 'file' | 'folder') => {
    const targetDir = getSelectedDir()
    if (targetDir && targetDir !== rootPath) {
      // Delegate creation to the selected folder's FileTreeNode
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
        await window.electronAPI.fsMkdir(newPath)
      } else {
        await window.electronAPI.fsWriteFile(newPath, '')
      }
      loadTree(rootPath)
    } catch (err) {
      console.error('[file-explorer] Failed to create entry:', err)
    }
  }, [rootCreating, rootCreateValue, rootPath, loadTree])

  const folderName = rootPath.split('/').filter(Boolean).pop() ?? 'Explorer'

  const handleRootContextMenu = useCallback(async (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    if (!window.electronAPI) return
    const id = await window.electronAPI.showContextMenu([
      { id: 'new-file', label: 'New File…' },
      { id: 'new-folder', label: 'New Folder…' },
      { type: 'separator' },
      { id: 'reveal', label: 'Reveal in Finder', accelerator: 'Alt+Cmd+R' },
      { id: 'open-terminal', label: 'Open in Integrated Terminal' },
      { type: 'separator' },
      { id: 'paste', label: 'Paste', accelerator: 'Cmd+V', enabled: hasClipboard() },
      { type: 'separator' },
      { id: 'remove-workspace', label: 'Remove Folder from Workspace' },
      { type: 'separator' },
      { id: 'find-in-folder', label: 'Find in Folder…', accelerator: 'Alt+Shift+F' },
      { type: 'separator' },
      { id: 'copy-path', label: 'Copy Path', accelerator: 'Alt+Cmd+C' },
      { id: 'copy-rel-path', label: 'Copy Relative Path', accelerator: 'Alt+Shift+Cmd+C' },
    ])
    switch (id) {
      case 'new-file': startRootCreate('file'); break
      case 'new-folder': startRootCreate('folder'); break
      case 'reveal': window.electronAPI.shellShowInFolder(rootPath); break
      case 'open-terminal':
        createTerminal(selectedWorkspaceId, undefined, undefined, { target: 'dock', zone: 'bottom' })
        break
      case 'paste': {
        const sources = getClipboard()
        for (const src of sources) {
          try {
            await window.electronAPI.fsCopy(src, rootPath)
          } catch (err) {
            console.error('[file-explorer] Paste failed:', err)
          }
        }
        handleReload()
        break
      }
      case 'remove-workspace':
        if (window.confirm(`Remove "${folderName}" from your workspaces?`)) {
          removeWorkspace(selectedWorkspaceId, true)
        }
        break
      case 'find-in-folder': openSearch(); break
      case 'copy-path': navigator.clipboard.writeText(rootPath); break
      case 'copy-rel-path': navigator.clipboard.writeText(folderName); break
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, startRootCreate, createTerminal, selectedWorkspaceId, removeWorkspace, openSearch])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className="flex flex-col h-full"
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
        void importDroppedEntries(files, rootPath, folderName).then((ok) => {
          if (ok) handleReload()
        })
      }}
    >
      <SidebarSectionHeader
        title="Explorer"
        subtitle={folderName}
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
              title="Search Files"
            >
              <MagnifyingGlass size={13} />
            </SidebarHeaderButton>
            <SidebarHeaderButton onClick={handleReload} title="Reload">
              <ArrowClockwise size={12} />
            </SidebarHeaderButton>
          </>
        }
      />

      {searchVisible && (
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
              placeholder="Search files"
              className="w-full bg-surface-5 text-primary text-xs pl-7 pr-2 py-1 rounded border border-subtle focus:border-blue-500/50 outline-none"
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
      {searchQuery.trim() ? (
        <div className="flex-1 overflow-y-auto py-1">
          {searchLoading && searchResults.length === 0 ? (
            <div className="flex items-center justify-center py-4 text-xs text-muted">Searching…</div>
          ) : searchResults.length === 0 ? (
            <div className="flex items-center justify-center py-4 text-xs text-muted">No matches</div>
          ) : (
            searchResults.map((r) => {
              const parentRel = r.relativePath.includes('/')
                ? r.relativePath.substring(0, r.relativePath.lastIndexOf('/'))
                : ''
              const isSel = selectedPaths.has(r.path)
              const { decoration, folderKind } = lookupNodeDecoration(gitTree, r.path, r.isDirectory)
              const nameColor = decoration
                ? decoration.colorClass
                : folderKind
                  ? folderColorClass(folderKind)
                  : 'text-primary'
              return (
                <div
                  key={r.path}
                  className={`flex flex-col gap-0.5 px-2 py-1 text-xs cursor-pointer ${isSel ? 'bg-surface-5' : 'hover:bg-surface-5/50'}`}
                  onClick={(e) => {
                    handleSelect(r.path, { shift: e.shiftKey, cmd: e.metaKey || e.ctrlKey })
                  }}
                  onDoubleClick={() => {
                    if (!r.isDirectory) handleFileOpen([r.path])
                  }}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="flex-shrink-0" style={{ color: r.isDirectory ? '#E2B855' : '#9CA3AF' }}>
                      {r.isDirectory ? <Folder size={13} /> : <File size={13} />}
                    </span>
                    <span className={`truncate ${nameColor} ${decoration?.strike ? 'line-through' : ''}`}>{r.name}</span>
                    {decoration && (
                      <span
                        className={`flex-shrink-0 w-4 text-center font-mono text-[10px] ${decoration.colorClass}`}
                        title={`Git: ${decoration.title}`}
                      >
                        {decoration.letter}
                      </span>
                    )}
                    {parentRel && <span className="truncate text-muted text-[10px]">{parentRel}</span>}
                  </div>
                  {r.contentPreview && (
                    <div className="text-muted text-[10px] truncate pl-5">
                      <span className="opacity-60">{r.contentLine}: </span>
                      {r.contentPreview}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      ) : isLoading && nodes.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-xs text-muted">
          Loading...
        </div>
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
          className="flex-1 overflow-y-auto py-1 outline-none"
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
                await window.electronAPI.fsRename(srcPath, destPath)
              } catch (err) {
                console.error('[file-explorer] Failed to move file:', err)
              }
            }
            handleReload()
          }}
        >
          {nodes.map((node) => (
            <FileTreeNode
              key={node.path}
              node={node}
              depth={0}
              git={gitTree}
              selectedPaths={selectedPaths}
              onSelect={handleSelect}
              onFileOpen={handleFileOpen}
              onDeletePaths={deletePaths}
              onTreeChanged={handleReload}
              refreshSignal={refreshSignal}
              visiblePaths={visiblePaths}
              searchQuery=""
              rootPath={rootPath}
              createRequest={createRequest}
              onCreateRequestHandled={() => setCreateRequest(null)}
            />
          ))}

          {/* Inline create input for root-level creation (from empty space context menu) */}
          {rootCreating && (
            <div className="h-7 flex items-center gap-1.5 px-2" style={{ paddingLeft: '8px' }}>
              <span className="flex-shrink-0 w-3" />
              <span className="flex-shrink-0" style={{ color: rootCreating === 'folder' ? '#E2B855' : '#9CA3AF' }}>
                {rootCreating === 'folder' ? (
                  <Folder size={14} />
                ) : (
                  <File size={14} />
                )}
              </span>
              <input
                ref={rootCreateInputRef}
                className="flex-1 min-w-0 bg-surface-5 text-primary text-sm px-1 rounded border border-blue-500/50 outline-none"
                value={rootCreateValue}
                placeholder={rootCreating === 'folder' ? 'folder name' : 'file name'}
                onChange={(e) => setRootCreateValue(e.target.value)}
                onBlur={commitRootCreate}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRootCreate()
                  if (e.key === 'Escape') setRootCreating(null)
                  e.stopPropagation()
                }}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
