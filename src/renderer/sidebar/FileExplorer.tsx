// =============================================================================
// FileExplorer — Git-aware file tree browser.
// Ported from FileExplorerView.swift + FileTreeModel.swift
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import log from '../lib/logger'
import { ArrowClockwise, FilePlus, FolderPlus, MagnifyingGlass, X, Folder, File } from '@phosphor-icons/react'
import type { FileTreeNode as FileTreeNodeType } from '../../shared/types'
import { FileTreeNode } from './FileTreeNode'
import { useAppStore } from '../stores/appStore'
import { useDockStore } from '../stores/dockStore'
import { SidebarSectionHeader, SidebarHeaderButton } from './SidebarSectionHeader'
import type { DockLayoutNode } from '../../shared/types'

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
  const [gitFiles, setGitFiles] = useState<Set<string> | undefined>(undefined)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [rootCreating, setRootCreating] = useState<'file' | 'folder' | null>(null)
  const [rootCreateValue, setRootCreateValue] = useState('')
  const [createRequest, setCreateRequest] = useState<{ type: 'file' | 'folder'; targetDir: string; seq: number } | null>(null)
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const rootCreateInputRef = useRef<HTMLInputElement>(null)
  const lastSelectedPath = useRef<string | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const rootPathRef = useRef(rootPath)
  const createSeqRef = useRef(0)

  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const createEditor = useAppStore((s) => s.createEditor)
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

  const loadTree = useCallback(async (dirPath: string) => {
    if (!window.electronAPI) return

    setIsLoading(true)
    try {
      const entries = await window.electronAPI.fsReadDir(dirPath)

      // Check git status
      const isGit = await window.electronAPI.gitIsRepo(dirPath)
      if (isGit) {
        const trackedFiles = await window.electronAPI.gitLsFiles(dirPath)
        setGitFiles(new Set(trackedFiles))
      } else {
        setGitFiles(undefined)
      }

      setNodes(entries)
    } catch {
      setNodes([])
    } finally {
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

    if (!rootPath || !window.electronAPI) return

    // Initial load
    loadTree(rootPath)

    // Start watcher
    window.electronAPI.fsWatchStart(rootPath).catch((err) => log.warn('[file-explorer] Watch start failed:', err))

    // Listen for events
    const unsubscribe = window.electronAPI.onFsWatchEvent(() => {
      // Debounced reload — just reload the whole tree for simplicity
      if (rootPathRef.current === rootPath) {
        loadTree(rootPath)
      }
    })

    cleanupRef.current = () => {
      unsubscribe()
      window.electronAPI?.fsWatchStop(rootPath).catch((err) => log.warn('[file-explorer] Watch stop failed:', err))
    }

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current()
        cleanupRef.current = null
      }
    }
  }, [rootPath, loadTree])

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleSelect = useCallback(
    (path: string, meta: { shift?: boolean; cmd?: boolean }) => {
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
          // Range selection
          const startIdx = visiblePaths.indexOf(lastSelectedPath.current)
          const endIdx = visiblePaths.indexOf(path)
          if (startIdx !== -1 && endIdx !== -1) {
            const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
            const next = new Set(prev)
            for (let i = lo; i <= hi; i++) {
              next.add(visiblePaths[i])
            }
            return next
          }
        }
        // Plain click — select only this
        lastSelectedPath.current = path
        return new Set([path])
      })
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
        createEditor(selectedWorkspaceId, filePath, undefined, placement)
      }
    },
    [createEditor, selectedWorkspaceId],
  )

  const handleReload = useCallback(() => {
    if (rootPath) loadTree(rootPath)
  }, [rootPath, loadTree])

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
      case 'remove-workspace':
        if (window.confirm(`Remove "${folderName}" from your workspaces?`)) {
          removeWorkspace(selectedWorkspaceId)
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
    <div className="flex flex-col h-full">
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
      {isLoading && nodes.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-xs text-muted">
          Loading...
        </div>
      ) : nodes.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 text-muted text-xs gap-2 p-4">
          <span className="text-2xl">&#128193;</span>
          <span>No files found</span>
        </div>
      ) : (
        <div
          className="flex-1 overflow-y-auto py-1"
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
              gitFiles={gitFiles}
              selectedPaths={selectedPaths}
              onSelect={handleSelect}
              onFileOpen={handleFileOpen}
              onTreeChanged={handleReload}
              visiblePaths={visiblePaths}
              searchQuery={searchQuery.trim().toLowerCase()}
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
