import { useState, useEffect, useCallback } from 'react'
import log from '../lib/logger'
import { useAppStore } from '../stores/appStore'
import { ensureWorkspaceFolder } from '../hooks/useShortcuts'
import {
  Terminal,
  Globe,
  FileCode,
  FolderOpen,
  Keyboard,
  Folder,
} from '@phosphor-icons/react'

// Abbreviate home directory in paths
function abbreviatePath(fullPath: string): string {
  const home = '/Users/'
  if (fullPath.startsWith(home)) {
    const rest = fullPath.slice(home.length)
    const slashIdx = rest.indexOf('/')
    return '~' + (slashIdx >= 0 ? rest.slice(slashIdx) : '')
  }
  return fullPath
}

export default function WelcomePage({ workspaceId }: { workspaceId: string }) {
  const [recentProjects, setRecentProjects] = useState<string[]>([])

  useEffect(() => {
    window.electronAPI.recentProjectsGet().then(setRecentProjects).catch((err) => log.warn('[welcome] Failed to load recent projects:', err))
  }, [])

  const openFolder = useCallback(async () => {
    const path = await window.electronAPI.openFolderDialog()
    if (path) {
      const app = useAppStore.getState()
      app.setWorkspaceRootPath(workspaceId, path)
      app.createTerminal(workspaceId)
    }
  }, [workspaceId])

  const openRecentProject = useCallback(
    (path: string) => {
      const app = useAppStore.getState()
      app.setWorkspaceRootPath(workspaceId, path)
      app.createTerminal(workspaceId)
    },
    [workspaceId],
  )

  const newTerminal = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(workspaceId)
    if (wsId) useAppStore.getState().createTerminal(wsId)
  }, [workspaceId])

  const newEditor = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(workspaceId)
    if (wsId) useAppStore.getState().createEditor(wsId)
  }, [workspaceId])

  const newBrowser = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(workspaceId)
    if (wsId) useAppStore.getState().createBrowser(wsId)
  }, [workspaceId])

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
      <div className="pointer-events-auto max-w-2xl w-full px-8">
        {/* Header */}
        <div className="flex flex-col items-center mb-10">
          <svg viewBox="0 0 389 204" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-8 text-white/90 mb-2">
            <path d="M274 203.2L307.29 1.79999H388.29L384.51 24.84H329.97L320.5 80.16H342.22H366.34L362.74 103.2H338.62H316.5L304.06 180.16H358.6L355 203.2H314.5H274Z" fill="currentColor"/>
            <path d="M201.264 203.2L230.424 26.5H197.124L201.264 1.3H294.864L290.724 26.5H257.424L228.264 203.2H201.264Z" fill="currentColor"/>
            <path d="M89 133.2L142.1 1.79999H176.3L188 133.2H161.18L159.56 103.5H128.24L117.26 133.2H89ZM136.16 81.9H158.3L157.04 50.22C156.92 45.66 156.68 41.16 156.32 36.72C156.08 32.16 155.9 28.62 155.78 26.1C154.94 28.62 153.8 32.1 152.36 36.54C151.04 40.98 149.54 45.48 147.86 50.04L136.16 81.9Z" fill="currentColor"/>
            <path d="M38.1825 135C29.4225 135 21.9825 133.38 15.8625 130.14C9.7425 126.78 5.3625 122.16 2.7225 116.28C0.0824997 110.28 -0.6375 103.32 0.5625 95.4L9.3825 39.6C10.7025 31.56 13.6425 24.6 18.2025 18.72C22.7625 12.84 28.5825 8.27999 35.6625 5.04C42.8625 1.68 50.8425 0 59.6025 0C68.4825 0 75.9225 1.68 81.9225 5.04C87.9225 8.27999 92.3025 12.84 95.0625 18.72C97.8225 24.6 98.5425 31.56 97.2225 39.6H70.2225C71.1825 34.32 70.4025 30.3 67.8825 27.54C65.3625 24.78 61.4025 23.4 56.0025 23.4C50.6025 23.4 46.2225 24.78 42.8625 27.54C39.5025 30.3 37.3425 34.32 36.3825 39.6L27.5625 95.4C26.7225 100.56 27.5625 104.58 30.0825 107.46C32.6025 110.22 36.5625 111.6 41.9625 111.6C47.3625 111.6 51.7425 110.22 55.1025 107.46C58.4625 104.58 60.5625 100.56 61.4025 95.4H88.4025C87.2025 103.32 84.2625 110.28 79.5825 116.28C75.0225 122.16 69.2025 126.78 62.1225 130.14C55.0425 133.38 47.0625 135 38.1825 135Z" fill="currentColor"/>
          </svg>
          <p className="text-sm text-white/40 mt-1">
            Infinite canvas for coding
          </p>
        </div>

        {/* Two-column layout: Start + Recent */}
        <div className="flex gap-12">
          {/* Start actions */}
          <div className="flex-1">
            <h2 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3">
              Start
            </h2>
            <div className="flex flex-col gap-1">
              <ActionItem
                icon={<FolderOpen size={16} />}
                label="Open Folder..."
                onClick={openFolder}
              />
              <ActionItem
                icon={<Terminal size={16} />}
                label="New Terminal"
                shortcut="⌘T"
                onClick={newTerminal}
              />
              <ActionItem
                icon={<FileCode size={16} />}
                label="New Editor"
                shortcut="⌘⇧E"
                onClick={newEditor}
              />
              <ActionItem
                icon={<Globe size={16} />}
                label="New Browser"
                shortcut="⌘⇧B"
                onClick={newBrowser}
              />
            </div>
          </div>

          {/* Recent Projects */}
          {recentProjects.length > 0 && (
            <div className="flex-1">
              <h2 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3">
                Recent
              </h2>
              <div className="flex flex-col gap-0.5">
                {recentProjects.map((projectPath) => {
                  const name = projectPath.split('/').filter(Boolean).pop() ?? projectPath
                  const parent = abbreviatePath(
                    projectPath.split('/').slice(0, -1).join('/'),
                  )
                  return (
                    <button
                      key={projectPath}
                      className="flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-white/5 transition-colors group"
                      onClick={() => openRecentProject(projectPath)}
                    >
                      <Folder
                        size={14}
                        className="text-white/30 group-hover:text-white/60 flex-shrink-0"
                      />
                      <span className="text-sm text-blue-400 group-hover:text-blue-300 truncate">
                        {name}
                      </span>
                      <span className="text-xs text-white/25 truncate">
                        {parent}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Keyboard shortcuts */}
        <div className="mt-10 pt-6 border-t border-white/5">
          <h2 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3">
            Keyboard Shortcuts
          </h2>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1">
            <ShortcutRow keys="⌘T" label="New Terminal" />
            <ShortcutRow keys="⌘⇧B" label="New Browser" />
            <ShortcutRow keys="⌘⇧E" label="New Editor" />
            <ShortcutRow keys="⌘K" label="Command Palette" />
            <ShortcutRow keys="⌘\" label="Toggle Sidebar" />
            <ShortcutRow keys="⌘0" label="Reset Zoom" />
          </div>
        </div>
      </div>
    </div>
  )
}

function ActionItem({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  shortcut?: string
  onClick: () => void
}) {
  return (
    <button
      className="flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-white/5 transition-colors group"
      onClick={onClick}
    >
      <span className="text-white/30 group-hover:text-white/60">{icon}</span>
      <span className="text-sm text-blue-400 group-hover:text-blue-300">
        {label}
      </span>
      {shortcut && (
        <span className="ml-auto text-xs text-white/20">{shortcut}</span>
      )}
    </button>
  )
}

function ShortcutRow({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-white/50 font-mono w-10 text-right">
        {keys}
      </span>
      <span className="text-xs text-white/30">{label}</span>
    </div>
  )
}
