// =============================================================================
// GitPanel — Git status, diff, staging, and commit UI for CanvasIDE
// =============================================================================

import React, { useState, useCallback, useEffect } from 'react'
import { useAppStore } from '../stores/appStore'

interface GitFile {
  path: string
  index: string
  working_dir: string
}

interface GitPanelProps {
  panelId: string
  workspaceId: string
  nodeId: string
}

export default function GitPanel({ panelId: _panelId, workspaceId, nodeId: _nodeId }: GitPanelProps) {
  const rootPath = useAppStore((s) => s.workspaces.find(w => w.id === workspaceId)?.rootPath)
  const [files, setFiles] = useState<GitFile[]>([])
  const [branch, setBranch] = useState<string | null>(null)
  const [commitMsg, setCommitMsg] = useState('')
  const [diff, setDiff] = useState('')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!rootPath) return
    setIsLoading(true)
    try {
      const status = await window.electronAPI.gitStatus(rootPath)
      setFiles(status.files)
      setBranch(status.current)
    } catch { /* not a git repo */ }
    setIsLoading(false)
  }, [rootPath])

  useEffect(() => { refresh() }, [refresh])

  const handleSelectFile = useCallback(async (filePath: string) => {
    if (!rootPath) return
    setSelectedFile(filePath)
    try {
      const d = await window.electronAPI.gitDiff(rootPath, filePath)
      setDiff(d)
    } catch { setDiff('') }
  }, [rootPath])

  const handleStage = useCallback(async (filePath: string) => {
    if (!rootPath) return
    await window.electronAPI.gitStage(rootPath, filePath)
    refresh()
  }, [rootPath, refresh])

  const handleUnstage = useCallback(async (filePath: string) => {
    if (!rootPath) return
    await window.electronAPI.gitUnstage(rootPath, filePath)
    refresh()
  }, [rootPath, refresh])

  const handleCommit = useCallback(async () => {
    if (!rootPath || !commitMsg.trim()) return
    await window.electronAPI.gitCommit(rootPath, commitMsg.trim())
    setCommitMsg('')
    setDiff('')
    setSelectedFile(null)
    refresh()
  }, [rootPath, commitMsg, refresh])

  if (!rootPath) {
    return (
      <div className="flex items-center justify-center h-full text-white/30 text-sm">
        Set a workspace root to use Git
      </div>
    )
  }

  const staged = files.filter(f => f.index !== ' ' && f.index !== '?')
  const unstaged = files.filter(f => f.working_dir !== ' ')

  return (
    <div className="flex flex-col h-full bg-[#1E1E24] text-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.05]">
        <span className="text-white/60">
          {branch ? `Branch: ${branch}` : 'Git'}
        </span>
        <button onClick={refresh} className="text-white/40 hover:text-white/80 text-xs">
          ↻ Refresh
        </button>
      </div>

      {/* File lists */}
      <div className="flex-1 overflow-y-auto">
        {staged.length > 0 && (
          <div>
            <div className="px-3 py-1 text-xs text-green-400/60 uppercase">Staged</div>
            {staged.map(f => (
              <div
                key={`s-${f.path}`}
                className={`flex items-center px-3 py-1 hover:bg-white/[0.03] cursor-pointer ${selectedFile === f.path ? 'bg-white/[0.05]' : ''}`}
                onClick={() => handleSelectFile(f.path)}
              >
                <span className="text-green-400 w-4 text-center mr-2 font-mono">{f.index}</span>
                <span className="text-white/70 flex-1 truncate">{f.path}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleUnstage(f.path) }}
                  className="text-white/30 hover:text-white/60 text-xs ml-2 flex-shrink-0"
                >
                  Unstage
                </button>
              </div>
            ))}
          </div>
        )}
        {unstaged.length > 0 && (
          <div>
            <div className="px-3 py-1 text-xs text-orange-400/60 uppercase">Changes</div>
            {unstaged.map(f => (
              <div
                key={`u-${f.path}`}
                className={`flex items-center px-3 py-1 hover:bg-white/[0.03] cursor-pointer ${selectedFile === f.path ? 'bg-white/[0.05]' : ''}`}
                onClick={() => handleSelectFile(f.path)}
              >
                <span className="text-orange-400 w-4 text-center mr-2 font-mono">{f.working_dir}</span>
                <span className="text-white/70 flex-1 truncate">{f.path}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleStage(f.path) }}
                  className="text-white/30 hover:text-white/60 text-xs ml-2 flex-shrink-0"
                >
                  Stage
                </button>
              </div>
            ))}
          </div>
        )}
        {files.length === 0 && !isLoading && (
          <div className="px-3 py-4 text-white/30 text-center">Clean working tree</div>
        )}
        {isLoading && (
          <div className="px-3 py-4 text-white/20 text-center text-xs">Loading...</div>
        )}
      </div>

      {/* Diff preview */}
      {diff && (
        <div className="border-t border-white/[0.05] max-h-[200px] overflow-y-auto">
          <pre className="text-xs font-mono p-2 text-white/60 whitespace-pre-wrap">{diff.slice(0, 3000)}</pre>
        </div>
      )}

      {/* Commit */}
      <div className="p-2 border-t border-white/[0.05]">
        <input
          type="text"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCommit() }}
          className="w-full bg-[#28282E] text-white text-xs px-2 py-1.5 rounded border border-white/[0.1] outline-none focus:border-blue-500/50 mb-1.5"
          placeholder="Commit message..."
        />
        <button
          onClick={handleCommit}
          disabled={!commitMsg.trim() || staged.length === 0}
          className="w-full py-1.5 bg-green-600/30 hover:bg-green-600/40 text-white/80 text-xs rounded disabled:opacity-30 transition-colors"
        >
          Commit ({staged.length} staged)
        </button>
      </div>
    </div>
  )
}
