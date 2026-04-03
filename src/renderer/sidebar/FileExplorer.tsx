// =============================================================================
// FileExplorer — Git-aware file tree browser.
// Ported from FileExplorerView.swift + FileTreeModel.swift
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import log from '../lib/logger'
import { RotateCw } from 'lucide-react'
import type { FileTreeNode as FileTreeNodeType } from '../../shared/types'
import { FileTreeNode } from './FileTreeNode'
import ContextMenu, { type ContextMenuItem } from '../ui/ContextMenu'
import { useAppStore } from '../stores/appStore'
import { useDockStore } from '../stores/dockStore'
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
  const [rootContextMenu, setRootContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [rootCreating, setRootCreating] = useState<'file' | 'folder' | null>(null)
  const [rootCreateValue, setRootCreateValue] = useState('')
  const rootCreateInputRef = useRef<HTMLInputElement>(null)
  const lastSelectedPath = useRef<string | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const rootPathRef = useRef(rootPath)

  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const createEditor = useAppStore((s) => s.createEditor)

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
    (filePaths: string[]) => {
      const placement = isCanvasActiveInCenter()
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

  const startRootCreate = useCallback((type: 'file' | 'folder') => {
    setRootCreateValue('')
    setRootCreating(type)
    setTimeout(() => rootCreateInputRef.current?.focus(), 0)
  }, [])

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
    } catch {
      /* ignore */
    }
  }, [rootCreating, rootCreateValue, rootPath, loadTree])

  const handleRootContextMenu = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      e.preventDefault()
      setRootContextMenu({ x: e.clientX, y: e.clientY })
    }
  }, [])

  const rootContextMenuItems: ContextMenuItem[] = [
    { label: 'New File…', onClick: () => startRootCreate('file') },
    { label: 'New Folder…', onClick: () => startRootCreate('folder') },
  ]

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const folderName = rootPath.split('/').filter(Boolean).pop() ?? 'Explorer'

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center px-3 py-2 flex-shrink-0">
        <span className="text-[12px] text-white/40 font-medium">
          Explorer
        </span>
        <div className="flex-1" />
        <button
          className="text-white/40 hover:text-white/70 transition-colors"
          onClick={handleReload}
          title="Reload"
        >
          <RotateCw size={14} strokeWidth={1.5} />
        </button>
      </div>

      {/* Divider */}
      <div className="h-[1px] bg-white/10 mx-2 flex-shrink-0" />

      {/* Folder name label */}
      <div className="px-3 py-1 flex-shrink-0">
        <span className="text-xs text-white/30 font-medium truncate block">{folderName}</span>
      </div>

      {/* Tree content */}
      {isLoading && nodes.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-xs text-white/30">
          Loading...
        </div>
      ) : nodes.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 text-white/30 text-xs gap-2 p-4">
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
            />
          ))}

          {/* Inline create input for root-level creation (from empty space context menu) */}
          {rootCreating && (
            <div className="h-7 flex items-center gap-1.5 px-2" style={{ paddingLeft: '8px' }}>
              <span className="flex-shrink-0 w-3" />
              <span className="flex-shrink-0" style={{ color: rootCreating === 'folder' ? '#E2B855' : '#9CA3AF' }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                  {rootCreating === 'folder' ? (
                    <path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3a1 1 0 0 0-1 1z" />
                  ) : (
                    <>
                      <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2z" />
                      <polyline points="9 2 9 6 13 6" />
                    </>
                  )}
                </svg>
              </span>
              <input
                ref={rootCreateInputRef}
                className="flex-1 min-w-0 bg-[#2a2a30] text-white/90 text-sm px-1 rounded border border-blue-500/50 outline-none"
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

          {/* Root-level context menu (empty space) */}
          {rootContextMenu && (
            <ContextMenu
              x={rootContextMenu.x}
              y={rootContextMenu.y}
              items={rootContextMenuItems}
              onClose={() => setRootContextMenu(null)}
            />
          )}
        </div>
      )}
    </div>
  )
}
