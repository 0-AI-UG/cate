// =============================================================================
// GlobalSearch — Overlay for searching across all open editor panels.
// Triggered by the globalSearch shortcut (Cmd+Shift+H).
// =============================================================================

import React, { useState, useCallback, useEffect } from 'react'
import { useUIStore } from '../stores/uiStore'
import { useAppStore } from '../stores/appStore'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface SearchResult {
  filePath: string
  panelId: string
  nodeId: string
  line: number
  text: string
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function GlobalSearch() {
  const canvasApi = useCanvasStoreApi()
  const show = useUIStore((s) => s.showGlobalSearch)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)

  const close = useCallback(() => {
    useUIStore.getState().setShowGlobalSearch(false)
    setQuery('')
    setResults([])
  }, [])

  // Search across open editor files
  const doSearch = useCallback(async (searchText: string) => {
    if (!searchText || searchText.length < 2) {
      setResults([])
      return
    }

    const workspace = useAppStore.getState().workspaces.find(
      (w) => w.id === useAppStore.getState().selectedWorkspaceId,
    )
    if (!workspace) return

    const canvasNodes = canvasApi.getState().nodes
    const found: SearchResult[] = []

    for (const [panelId, panel] of Object.entries(workspace.panels)) {
      if (panel.type !== 'editor' || !panel.filePath) continue

      try {
        const content = await window.electronAPI.fsReadFile(panel.filePath)
        const lines = content.split('\n')
        const lowerQuery = searchText.toLowerCase()

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lowerQuery)) {
            const nodeId =
              Object.values(canvasNodes).find((n) => n.panelId === panelId)?.id || ''
            found.push({
              filePath: panel.filePath,
              panelId,
              nodeId,
              line: i + 1,
              text: lines[i].trim(),
            })
            if (found.length >= 50) break
          }
        }
      } catch {
        /* file not readable */
      }
      if (found.length >= 50) break
    }

    setResults(found)
    setSelectedIndex(0)
  }, [])

  // Debounced search
  useEffect(() => {
    if (!show) return
    const timer = setTimeout(() => doSearch(query), 300)
    return () => clearTimeout(timer)
  }, [query, show, doSearch])

  const selectResult = useCallback(
    (result: SearchResult) => {
      if (result.nodeId) {
        canvasApi.getState().focusAndCenter(result.nodeId)
      }
      close()
    },
    [close],
  )

  // Keyboard navigation
  useEffect(() => {
    if (!show) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1))
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      }
      if (e.key === 'Enter' && results[selectedIndex]) {
        selectResult(results[selectedIndex])
      }
    }
    document.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [show, results, selectedIndex, close, selectResult])

  if (!show) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/40"
      onClick={close}
    >
      <div
        className="w-[600px] max-h-[500px] rounded-xl overflow-hidden flex flex-col bg-surface-4 border border-subtle"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-surface-3 text-primary text-sm px-3 py-2 rounded-lg border border-subtle outline-none focus:border-blue-500/50"
            placeholder="Search in open editors..."
          />
        </div>

        {results.length > 0 && (
          <div className="flex-1 overflow-y-auto border-t border-subtle">
            {results.map((result, i) => (
              <div
                key={`${result.filePath}:${result.line}`}
                className={`px-3 py-2 cursor-pointer text-sm ${
                  i === selectedIndex ? 'bg-blue-600/20' : 'hover:bg-hover'
                }`}
                onClick={() => selectResult(result)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-muted text-xs font-mono">
                    {result.filePath.split('/').pop()}:{result.line}
                  </span>
                </div>
                <div className="text-primary text-xs font-mono truncate mt-0.5">
                  {result.text}
                </div>
              </div>
            ))}
          </div>
        )}

        {query.length >= 2 && results.length === 0 && (
          <div className="px-3 py-4 text-sm text-muted text-center border-t border-subtle">
            No results found
          </div>
        )}
      </div>
    </div>
  )
}
