// =============================================================================
// FileExplorer — Git-aware file tree browser.
// Ported from FileExplorerView.swift + FileTreeModel.swift
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import log from '../lib/logger'
import { RotateCw } from 'lucide-react'
import type { FileTreeNode as FileTreeNodeType } from '../../shared/types'
import { FileTreeNode } from './FileTreeNode'
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
        </div>
      )}
    </div>
  )
}
