// =============================================================================
// FileTreeNode — Recursive tree node for the file explorer.
// Ported from FileTreeNodeView in FileExplorerView.swift + FileTreeNode.swift
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  CaretRight,
  Folder,
  FolderOpen,
  File,
  FileCode,
  Code,
  FileText,
  BracketsCurly,
  Globe,
  PaintBrush,
  Image as ImageIcon,
} from '@phosphor-icons/react'
import log from '../lib/logger'
import type { FileTreeNode as FileTreeNodeType } from '../../shared/types'

// -----------------------------------------------------------------------------
// Icon mapping — extension to inline SVG icons with colors
// Mirrors the Swift sfSymbolName mapping from FileTreeNode.swift
// -----------------------------------------------------------------------------

interface IconDef {
  icon: React.ReactNode
  color: string
}

function getFileIcon(extension: string, isDirectory: boolean, isExpanded: boolean): IconDef {
  if (isDirectory) {
    return isExpanded ? ICON_FOLDER_OPEN : ICON_FOLDER
  }

  switch (extension.toLowerCase()) {
    case 'swift':
      return ICON_SWIFT
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return ICON_JS
    case 'py':
      return ICON_PY
    case 'json':
      return ICON_JSON
    case 'md':
    case 'markdown':
      return ICON_MD
    case 'html':
    case 'htm':
      return ICON_HTML
    case 'css':
    case 'scss':
      return ICON_CSS
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
      return ICON_IMAGE
    default:
      return ICON_DEFAULT
  }
}

// -----------------------------------------------------------------------------
// Pre-created phosphor icon elements (sized 14)
// -----------------------------------------------------------------------------

const ICON_PROPS = { size: 14 } as const

const ICON_FOLDER_OPEN: IconDef = { icon: <FolderOpen {...ICON_PROPS} />, color: '#E2B855' }
const ICON_FOLDER: IconDef = { icon: <Folder {...ICON_PROPS} />, color: '#E2B855' }
const ICON_SWIFT: IconDef = { icon: <Code {...ICON_PROPS} />, color: '#F97316' }
const ICON_JS: IconDef = { icon: <FileCode {...ICON_PROPS} />, color: '#EAB308' }
const ICON_PY: IconDef = { icon: <FileCode {...ICON_PROPS} />, color: '#3B82F6' }
const ICON_JSON: IconDef = { icon: <BracketsCurly {...ICON_PROPS} />, color: '#A78BFA' }
const ICON_MD: IconDef = { icon: <FileText {...ICON_PROPS} />, color: '#9CA3AF' }
const ICON_HTML: IconDef = { icon: <Globe {...ICON_PROPS} />, color: '#3B82F6' }
const ICON_CSS: IconDef = { icon: <PaintBrush {...ICON_PROPS} />, color: '#A855F7' }
const ICON_IMAGE: IconDef = { icon: <ImageIcon {...ICON_PROPS} />, color: '#14B8A6' }
const ICON_DEFAULT: IconDef = { icon: <File {...ICON_PROPS} />, color: '#9CA3AF' }

// -----------------------------------------------------------------------------
// FileTreeNode component
// -----------------------------------------------------------------------------

interface FileTreeNodeProps {
  node: FileTreeNodeType
  depth: number
  gitFiles?: Set<string>
  selectedPaths: Set<string>
  onSelect: (path: string, meta: { shift?: boolean; cmd?: boolean }) => void
  onFileOpen: (paths: string[], mode?: 'dock' | 'canvas') => void
  onTreeChanged?: () => void
  /** Flat ordered list of visible file paths for shift-click range selection */
  visiblePaths: string[]
  /** Lowercased search query; when non-empty, filters files and force-expands directories */
  searchQuery?: string
  /** Workspace root path — used to compute relative paths for "Copy Relative Path". */
  rootPath: string
}

export const FileTreeNode: React.FC<FileTreeNodeProps> = ({
  node,
  depth,
  gitFiles,
  selectedPaths,
  onSelect,
  onFileOpen,
  onTreeChanged,
  visiblePaths,
  searchQuery,
  rootPath,
}) => {
  const isSearching = !!searchQuery
  const [isExpanded, setIsExpanded] = useState(node.isExpanded)
  const [children, setChildren] = useState<FileTreeNodeType[]>(node.children)
  const [isLoading, setIsLoading] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [isCreating, setIsCreating] = useState<'file' | 'folder' | null>(null)
  const [renameValue, setRenameValue] = useState(node.name)
  const [createValue, setCreateValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const createInputRef = useRef<HTMLInputElement>(null)

  // Determine if this node should be dimmed (not in git tracked files)
  const isDimmed = gitFiles != null && !node.isDirectory && !gitFiles.has(node.path)

  const isSelected = selectedPaths.has(node.path)
  const effectiveExpanded = isExpanded || isSearching
  const iconDef = getFileIcon(node.fileExtension, node.isDirectory, effectiveExpanded)

  // Auto-load directory children when search becomes active
  useEffect(() => {
    if (isSearching && node.isDirectory && children.length === 0 && window.electronAPI) {
      window.electronAPI.fsReadDir(node.path).then(setChildren).catch(() => {})
    }
  }, [isSearching, node.isDirectory, node.path, children.length])

  // While searching, hide files whose name doesn't match
  if (isSearching && !node.isDirectory && !node.name.toLowerCase().includes(searchQuery!)) {
    return null
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const reloadChildren = useCallback(async () => {
    if (!window.electronAPI || !node.isDirectory) return
    try {
      const entries = await window.electronAPI.fsReadDir(node.path)
      setChildren(entries)
    } catch {
      /* ignore */
    }
  }, [node.path, node.isDirectory])

  const parentDir = node.isDirectory ? node.path : node.path.substring(0, node.path.lastIndexOf('/'))

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    const meta = { shift: e.shiftKey, cmd: e.metaKey || e.ctrlKey }
    if (node.isDirectory) {
      // Directories: toggle expand on click, but also select
      onSelect(node.path, meta)
      if (!meta.shift && !meta.cmd) {
        const willExpand = !isExpanded
        setIsExpanded(willExpand)

        if (willExpand && children.length === 0 && window.electronAPI) {
          setIsLoading(true)
          try {
            const entries = await window.electronAPI.fsReadDir(node.path)
            setChildren(entries)
          } catch {
            setChildren([])
          } finally {
            setIsLoading(false)
          }
        }
      }
    } else {
      onSelect(node.path, meta)
      // Plain click on a file: open it as a dock tab next to the canvas.
      // Modifier-clicks (cmd/shift) only adjust the selection.
      if (!meta.shift && !meta.cmd) {
        onFileOpen([node.path], 'dock')
      }
    }
  }, [node, isExpanded, children.length, onSelect, onFileOpen])

  // Forward declarations are filled in below; handleContextMenu uses them via refs
  // through closure on the latest functions defined later in render.
  const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!window.electronAPI) return

    const selectedFiles = [...selectedPaths]
    const pathsToOpen = selectedPaths.has(node.path) && selectedFiles.length > 0
      ? selectedFiles
      : [node.path]

    const relPath = node.path.startsWith(rootPath + '/')
      ? node.path.slice(rootPath.length + 1)
      : node.path

    const items: import('../../shared/electron-api').NativeContextMenuItem[] = []
    if (!node.isDirectory) {
      items.push({
        id: 'open',
        label: pathsToOpen.length > 1 ? `Open ${pathsToOpen.length} Files` : 'Open',
      })
      items.push({
        id: 'open-on-canvas',
        label: pathsToOpen.length > 1 ? `Open ${pathsToOpen.length} Files on Canvas` : 'Open on Canvas',
      })
      items.push({ type: 'separator' })
    }
    items.push(
      { id: 'new-file', label: 'New File…' },
      { id: 'new-folder', label: 'New Folder…' },
      { type: 'separator' },
      { id: 'reveal', label: 'Reveal in Finder', accelerator: 'Alt+Cmd+R' },
      { type: 'separator' },
      { id: 'rename', label: 'Rename…', accelerator: 'Return' },
      { id: 'copy-path', label: 'Copy Path', accelerator: 'Alt+Cmd+C' },
      { id: 'copy-rel-path', label: 'Copy Relative Path', accelerator: 'Alt+Shift+Cmd+C' },
      { id: 'copy-name', label: 'Copy Name' },
      { type: 'separator' },
      { id: 'delete', label: 'Delete', accelerator: 'Cmd+Backspace' },
    )

    const id = await window.electronAPI.showContextMenu(items)
    switch (id) {
      case 'open': onFileOpen(pathsToOpen, 'dock'); break
      case 'open-on-canvas': onFileOpen(pathsToOpen, 'canvas'); break
      case 'new-file': startCreate('file'); break
      case 'new-folder': startCreate('folder'); break
      case 'reveal': window.electronAPI.shellShowInFolder(node.path); break
      case 'rename': startRename(); break
      case 'copy-path': navigator.clipboard.writeText(node.path); break
      case 'copy-rel-path': navigator.clipboard.writeText(relPath); break
      case 'copy-name': navigator.clipboard.writeText(node.name); break
      case 'delete': handleDelete(); break
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, rootPath, selectedPaths, onFileOpen])

  // --- Rename ---
  const startRename = useCallback(() => {
    setRenameValue(node.name)
    setIsRenaming(true)
    setTimeout(() => {
      const input = renameInputRef.current
      if (input) {
        input.focus()
        const dotIndex = node.name.lastIndexOf('.')
        input.setSelectionRange(0, dotIndex > 0 && !node.isDirectory ? dotIndex : node.name.length)
      }
    }, 0)
  }, [node.name, node.isDirectory])

  const commitRename = useCallback(async () => {
    setIsRenaming(false)
    const trimmed = renameValue.trim()
    if (!trimmed || trimmed === node.name || !window.electronAPI) return
    const newPath = node.path.substring(0, node.path.lastIndexOf('/') + 1) + trimmed
    try {
      await window.electronAPI.fsRename(node.path, newPath)
      onTreeChanged?.()
    } catch {
      /* ignore */
    }
  }, [renameValue, node.name, node.path, onTreeChanged])

  // --- Create new file/folder ---
  const startCreate = useCallback((type: 'file' | 'folder') => {
    if (node.isDirectory) {
      setIsExpanded(true)
      if (children.length === 0) {
        window.electronAPI?.fsReadDir(node.path).then(setChildren).catch((err) => log.warn('[file-tree] Read dir failed:', err))
      }
    }
    setCreateValue('')
    setIsCreating(type)
    setTimeout(() => createInputRef.current?.focus(), 0)
  }, [node.isDirectory, node.path, children.length])

  const commitCreate = useCallback(async () => {
    const type = isCreating
    setIsCreating(null)
    const trimmed = createValue.trim()
    if (!trimmed || !window.electronAPI || !type) return
    const dir = node.isDirectory ? node.path : parentDir
    const newPath = dir + '/' + trimmed
    try {
      if (type === 'folder') {
        await window.electronAPI.fsMkdir(newPath)
      } else {
        await window.electronAPI.fsWriteFile(newPath, '')
      }
      if (node.isDirectory) {
        await reloadChildren()
      }
      onTreeChanged?.()
    } catch {
      /* ignore */
    }
  }, [isCreating, createValue, node.isDirectory, node.path, parentDir, reloadChildren, onTreeChanged])

  // --- Delete ---
  const handleDelete = useCallback(async () => {
    if (!window.electronAPI) return
    const confirmed = window.confirm(`Delete "${node.name}"?${node.isDirectory ? ' This will delete all contents.' : ''}`)
    if (!confirmed) return
    try {
      await window.electronAPI.fsDelete(node.path)
      onTreeChanged?.()
    } catch {
      /* ignore */
    }
  }, [node.name, node.path, node.isDirectory, onTreeChanged])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      {/* Node row */}
      <div
        className={`h-7 flex items-center gap-1.5 px-2 text-sm text-white/70 cursor-pointer rounded-sm ${
          isSelected ? 'bg-white/[0.1] text-white/90' : 'hover:bg-white/[0.05]'
        } ${isDimmed ? 'opacity-40' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={(e: React.DragEvent) => {
          // If this node is selected and there are multiple selections, drag all
          const dragPaths = isSelected && selectedPaths.size > 1
            ? [...selectedPaths]
            : [node.path]
          e.dataTransfer.setData('application/cate-file', dragPaths[0])
          e.dataTransfer.setData('application/cate-files', JSON.stringify(dragPaths))
          e.dataTransfer.effectAllowed = 'copy'
        }}
      >
        {/* Chevron for directories */}
        {node.isDirectory ? (
          <span
            className="flex-shrink-0 text-white/40 transition-transform duration-150"
            style={{ transform: effectiveExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          >
            <CaretRight size={12} />
          </span>
        ) : (
          <span className="flex-shrink-0 w-3" />
        )}

        {/* File icon (folders show only the chevron) */}
        {!node.isDirectory && (
          <span className="flex-shrink-0" style={{ color: iconDef.color }}>
            {iconDef.icon}
          </span>
        )}

        {/* Name or rename input */}
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="flex-1 min-w-0 bg-[#262523] text-white/90 text-sm px-1 rounded border border-blue-500/50 outline-none"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setIsRenaming(false)
              e.stopPropagation()
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="truncate">{node.name}</span>
        )}

        {/* Loading indicator for lazy-loaded directories */}
        {isLoading && (
          <span className="text-xs text-white/30 ml-auto">...</span>
        )}
      </div>

      {/* Inline create input (shows as first child for directories, or sibling for files) */}
      {isCreating && (node.isDirectory ? isExpanded : true) && (
        <div
          className="h-7 flex items-center gap-1.5 px-2"
          style={{ paddingLeft: `${(node.isDirectory ? depth + 1 : depth) * 16 + 8}px` }}
        >
          <span className="flex-shrink-0 w-3" />
          <span className="flex-shrink-0" style={{ color: isCreating === 'folder' ? '#E2B855' : '#9CA3AF' }}>
            {isCreating === 'folder' ? <Folder {...ICON_PROPS} /> : <File {...ICON_PROPS} />}
          </span>
          <input
            ref={createInputRef}
            className="flex-1 min-w-0 bg-[#262523] text-white/90 text-sm px-1 rounded border border-blue-500/50 outline-none"
            value={createValue}
            placeholder={isCreating === 'folder' ? 'folder name' : 'file name'}
            onChange={(e) => setCreateValue(e.target.value)}
            onBlur={commitCreate}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitCreate()
              if (e.key === 'Escape') setIsCreating(null)
              e.stopPropagation()
            }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Expanded children */}
      {node.isDirectory && effectiveExpanded && (
        <div className="relative">
          <div
            className="absolute top-0 bottom-0 w-px bg-white/[0.08] pointer-events-none"
            style={{ left: `${depth * 16 + 8 + 5}px` }}
          />
          {children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              gitFiles={gitFiles}
              selectedPaths={selectedPaths}
              onSelect={onSelect}
              onFileOpen={onFileOpen}
              onTreeChanged={onTreeChanged}
              visiblePaths={visiblePaths}
              searchQuery={searchQuery}
              rootPath={rootPath}
            />
          ))}
        </div>
      )}

    </div>
  )
}
