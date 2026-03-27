// =============================================================================
// FileExplorer — Git-aware file tree browser.
// Ported from FileExplorerView.swift + FileTreeModel.swift
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { FileTreeNode as FileTreeNodeType } from '../../shared/types'
import { FileTreeNode } from './FileTreeNode'
import { useAppStore } from '../stores/appStore'

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
  const cleanupRef = useRef<(() => void) | null>(null)
  const rootPathRef = useRef(rootPath)

  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const createEditor = useAppStore((s) => s.createEditor)

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
    window.electronAPI.fsWatchStart(rootPath).catch(() => {})

    // Listen for events
    const unsubscribe = window.electronAPI.onFsWatchEvent(() => {
      // Debounced reload — just reload the whole tree for simplicity
      if (rootPathRef.current === rootPath) {
        loadTree(rootPath)
      }
    })

    cleanupRef.current = () => {
      unsubscribe()
      window.electronAPI?.fsWatchStop(rootPath).catch(() => {})
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

  const handleFileClick = useCallback(
    (filePath: string) => {
      createEditor(selectedWorkspaceId, filePath)
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
        <span className="text-xs text-white/40 font-semibold uppercase tracking-wider">
          Explorer
        </span>
        <div className="flex-1" />
        <button
          className="text-white/40 hover:text-white/70 transition-colors"
          onClick={handleReload}
          title="Reload"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2" />
            <polyline points="11.5 2.5 11.5 4.8 9.2 4.8" />
          </svg>
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
        <div className="flex-1 overflow-y-auto py-1">
          {nodes.map((node) => (
            <FileTreeNode
              key={node.path}
              node={node}
              depth={0}
              gitFiles={gitFiles}
              onFileClick={handleFileClick}
            />
          ))}
        </div>
      )}
    </div>
  )
}
