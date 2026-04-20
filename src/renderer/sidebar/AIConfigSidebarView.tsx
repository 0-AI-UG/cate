// =============================================================================
// AIConfigSidebarView — Agent setup sidebar with card-based design.
// Product logo cards for tools, sticky Skills/MCP at bottom.
// =============================================================================

import React, { useEffect, useCallback, useState, type DragEvent } from 'react'
import {
  Check, X, Plus, Trash, Play, Square, Lightning, PencilSimple,
  ArrowsClockwise, FolderOpen, CircleNotch, Eye, EyeSlash,
  Download, CaretDown, CaretRight, BookOpen, HardDrives,
} from '@phosphor-icons/react'
import type { AIToolId, AIToolPresence, MCPServerConfig, MCPServerDefinition, DockLayoutNode } from '../../shared/types'
import { MCPServerEditor } from '../dialogs/MCPServerEditor'
import { useAIConfigStore } from '../stores/aiConfigStore'
import { useAppStore } from '../stores/appStore'
import { useDockStore } from '../stores/dockStore'
import { searchRegistry } from '../lib/aiConfig/mcpRegistry'
import type { NativeContextMenuItem } from '../../shared/electron-api'
import { SidebarSectionHeader, SidebarHeaderButton } from './SidebarSectionHeader'

// =============================================================================
// Constants & helpers
// =============================================================================

function findActivePanel(node: DockLayoutNode): string | null {
  if (node.type === 'tabs') return node.panelIds[node.activeIndex] ?? null
  for (const child of node.children) {
    const result = findActivePanel(child)
    if (result) return result
  }
  return null
}

function getEditorPlacement() {
  const centerLayout = useDockStore.getState().zones.center.layout
  if (!centerLayout) return { target: 'dock' as const, zone: 'center' as const }
  const activePanelId = findActivePanel(centerLayout)
  if (!activePanelId) return { target: 'dock' as const, zone: 'center' as const }
  const appState = useAppStore.getState()
  const ws = appState.workspaces.find((w) => w.id === appState.selectedWorkspaceId)
  return ws?.panels[activePanelId]?.type === 'canvas'
    ? undefined
    : { target: 'dock' as const, zone: 'center' as const }
}

const INPUT_CLS = 'w-full bg-surface-5 border border-subtle rounded px-2 py-1 text-[12px] text-primary placeholder:text-muted focus:border-strong focus:outline-none font-mono'
const SKILL_DESTINATIONS = ['.claude/skills', '.cursor/rules'] as const

// =============================================================================
// Official monochrome product logos (from assets/logos/)
// =============================================================================

function ClaudeLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="currentColor">
      <path fillRule="evenodd" clipRule="evenodd" d="M142.27 316.619l73.655-41.326 1.238-3.589-1.238-1.996-3.589-.001-12.31-.759-42.084-1.138-36.498-1.516-35.361-1.896-8.897-1.895-8.34-10.995.859-5.484 7.482-5.03 10.717.935 23.683 1.617 35.537 2.452 25.782 1.517 38.193 3.968h6.064l.86-2.451-2.073-1.517-1.618-1.517-36.776-24.922-39.81-26.338-20.852-15.166-11.273-7.683-5.687-7.204-2.451-15.721 10.237-11.273 13.75.935 3.513.936 13.928 10.716 29.749 23.027 38.848 28.612 5.687 4.727 2.275-1.617.278-1.138-2.553-4.271-21.13-38.193-22.546-38.848-10.035-16.101-2.654-9.655c-.935-3.968-1.617-7.304-1.617-11.374l11.652-15.823 6.445-2.073 15.545 2.073 6.547 5.687 9.655 22.092 15.646 34.78 24.265 47.291 7.103 14.028 3.791 12.992 1.416 3.968 2.449-.001v-2.275l1.997-26.641 3.69-32.707 3.589-42.084 1.239-11.854 5.863-14.206 11.652-7.683 9.099 4.348 7.482 10.716-1.036 6.926-4.449 28.915-8.72 45.294-5.687 30.331h3.313l3.792-3.791 15.342-20.372 25.782-32.227 11.374-12.789 13.27-14.129 8.517-6.724 16.1-.001 11.854 17.617-5.307 18.199-16.581 21.029-13.75 17.819-19.716 26.54-12.309 21.231 1.138 1.694 2.932-.278 44.536-9.479 24.062-4.347 28.714-4.928 12.992 6.066 1.416 6.167-5.106 12.613-30.71 7.583-36.018 7.204-53.636 12.689-.657.48.758.935 24.164 2.275 10.337.556h25.301l47.114 3.514 12.309 8.139 7.381 9.959-1.238 7.583-18.957 9.655-25.579-6.066-59.702-14.205-20.474-5.106-2.83-.001v1.694l17.061 16.682 31.266 28.233 39.152 36.397 1.997 8.999-5.03 7.102-5.307-.758-34.401-25.883-13.27-11.651-30.053-25.302-1.996-.001v2.654l6.926 10.136 36.574 54.975 1.895 16.859-2.653 5.485-9.479 3.311-10.414-1.895-21.408-30.054-22.092-33.844-17.819-30.331-2.173 1.238-10.515 113.261-4.929 5.788-11.374 4.348-9.478-7.204-5.03-11.652 5.03-23.027 6.066-30.052 4.928-23.886 4.449-29.674 2.654-9.858-.177-.657-2.173.278-22.37 30.71-34.021 45.977-26.919 28.815-6.445 2.553-11.173-5.789 1.037-10.337 6.243-9.2 37.257-47.392 22.47-29.371 14.508-16.961-.101-2.451h-.859l-98.954 64.251-17.618 2.275-7.583-7.103.936-11.652 3.589-3.791 29.749-20.474z" />
    </svg>
  )
}

function CodexLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="currentColor">
      <path d="M474.123 209.81c11.525-34.577 7.569-72.423-10.838-103.904-27.696-48.168-83.433-72.94-137.794-61.414a127.14 127.14 0 00-95.475-42.49c-55.564 0-104.936 35.781-122.139 88.593-35.781 7.397-66.574 29.76-84.637 61.414-27.868 48.167-21.503 108.72 15.826 150.007-11.525 34.578-7.569 72.424 10.838 103.733 27.696 48.34 83.433 73.111 137.966 61.585 24.084 27.18 58.833 42.835 95.303 42.663 55.564 0 104.936-35.782 122.139-88.594 35.782-7.397 66.574-29.76 84.465-61.413 28.04-48.168 21.676-108.722-15.654-150.008v-.172zm-39.567-87.218c11.01 19.267 15.139 41.803 11.354 63.65-.688-.516-2.064-1.204-2.924-1.72l-101.152-58.49a16.965 16.965 0 00-16.687 0L206.621 194.5v-50.232l97.883-56.597c45.587-26.32 103.732-10.666 130.052 34.921zm-227.935 104.42l49.888-28.9 49.887 28.9v57.63l-49.887 28.9-49.888-28.9v-57.63zm23.223-191.81c22.364 0 43.867 7.742 61.07 22.02-.688.344-2.064 1.204-3.097 1.72L186.666 117.26c-5.161 2.925-8.258 8.43-8.258 14.45v136.934l-43.523-25.116V130.333c0-52.64 42.491-95.13 95.131-95.302l-.172.172zM52.14 168.697c11.182-19.268 28.557-34.062 49.544-41.803V247.14c0 6.02 3.097 11.354 8.258 14.45l118.354 68.295-43.695 25.288-97.711-56.425c-45.415-26.32-61.07-84.465-34.75-130.052zm26.665 220.71c-11.182-19.095-15.139-41.802-11.354-63.65.688.516 2.064 1.204 2.924 1.72l101.152 58.49a16.965 16.965 0 0016.687 0l118.354-68.467v50.232l-97.883 56.425c-45.587 26.148-103.732 10.665-130.052-34.75h.172zm204.54 87.39c-22.192 0-43.867-7.741-60.898-22.02a62.439 62.439 0 003.097-1.72l101.152-58.317c5.16-2.924 8.429-8.43 8.257-14.45V243.527l43.523 25.116v113.022c0 52.64-42.663 95.303-95.131 95.303v-.172zM461.22 343.303c-11.182 19.267-28.729 34.061-49.544 41.63V264.687c0-6.021-3.097-11.526-8.257-14.45L284.893 181.77l43.523-25.116 97.883 56.424c45.587 26.32 61.07 84.466 34.75 130.053l.172.172z" />
    </svg>
  )
}

function GeminiLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 65 65" fill="currentColor">
      <path d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.904 38.904 0 001.999 5.905c2.152 5 5.105 9.376 8.854 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 1.999c.66.166 1.124.758 1.124 1.438 0 .68-.464 1.273-1.125 1.439a38.902 38.902 0 00-5.905 1.999c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.973 38.973 0 00-2 5.906 1.485 1.485 0 01-1.438 1.124c-.68 0-1.272-.464-1.438-1.125a38.913 38.913 0 00-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.973 38.973 0 00-5.905-2A1.485 1.485 0 010 32.448c0-.68.465-1.272 1.125-1.438a38.903 38.903 0 005.905-2c5-2.151 9.376-5.104 13.125-8.854 3.75-3.749 6.703-8.125 8.855-13.125a38.972 38.972 0 001.999-5.905A1.485 1.485 0 0132.447 0z" />
    </svg>
  )
}

function CursorLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 400 400" fill="currentColor">
      <path d="M320.015 124.958L205.919 59.086C202.256 56.97 197.735 56.97 194.071 59.086L79.981 124.958C76.901 126.736 75 130.025 75 133.587V266.419C75 269.981 76.901 273.269 79.981 275.048L194.077 340.92C197.74 343.036 202.261 343.036 205.925 340.92L320.02 275.048C323.1 273.269 325.001 269.981 325.001 266.419V133.587C325.001 130.025 323.1 126.736 320.02 124.958H320.015ZM312.848 138.911L202.706 329.682C201.961 330.968 199.995 330.443 199.995 328.954V204.039C199.995 201.543 198.662 199.234 196.498 197.981L88.321 135.526C87.036 134.781 87.561 132.816 89.05 132.816H309.334C312.462 132.816 314.417 136.206 312.853 138.917H312.848V138.911Z" />
    </svg>
  )
}

function OpenCodeLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 42" fill="currentColor">
      <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" />
    </svg>
  )
}

const TOOL_LOGOS: Record<AIToolId, React.FC<{ size?: number }>> = {
  claude: ClaudeLogo,
  codex: CodexLogo,
  gemini: GeminiLogo,
  cursor: CursorLogo,
  opencode: OpenCodeLogo,
}

// =============================================================================
// Tool card
// =============================================================================

function ToolCard({ tool, rootPath, workspaceId }: {
  tool: AIToolPresence; rootPath: string; workspaceId: string
}) {
  const [expanded, setExpanded] = useState(false)
  const createConfig = useAIConfigStore((s) => s.createConfig)
  const scan = useAIConfigStore((s) => s.scan)
  const Logo = TOOL_LOGOS[tool.id]
  const existCount = tool.configFiles.filter((f) => f.exists).length
  const totalCount = tool.configFiles.length

  return (
    <div
      className="rounded-md bg-surface-5 border border-subtle overflow-hidden"
      onContextMenu={async (e) => {
        e.preventDefault()
        const items: NativeContextMenuItem[] = [
          { id: 'open', label: 'Open config files' },
          { id: 'reveal', label: 'Reveal in Finder' },
          { type: 'separator' },
          { id: 'remove', label: 'Remove Setup' },
        ]
        const id = await window.electronAPI.showContextMenu(items)
        switch (id) {
          case 'open': setExpanded(true); break
          case 'reveal': window.electronAPI.shellShowInFolder(rootPath); break
          case 'remove': {
            const files = tool.configFiles.filter((f) => f.exists && !f.isDirectory)
            const dirs = tool.configFiles.filter((f) => f.exists && f.isDirectory)
            for (const f of files) try { await window.electronAPI.fsDelete(`${rootPath}/${f.relativePath}`) } catch {}
            for (const d of dirs) try { await window.electronAPI.fsDelete(`${rootPath}/${d.relativePath}`) } catch {}
            scan(rootPath)
            break
          }
        }
      }}
    >
      {/* Card header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-3 py-3 hover:bg-hover transition-colors"
      >
        <div className="w-8 h-8 rounded-md bg-surface-5 flex items-center justify-center shrink-0 text-secondary">
          <Logo size={16} />
        </div>
        <div className="flex-1 text-left min-w-0">
          <div className="text-[13px] text-primary font-medium">{tool.name}</div>
          <div className="text-[11px] text-muted">
            {existCount === totalCount ? 'All files configured' : `${existCount}/${totalCount} files`}
          </div>
        </div>
        {expanded
          ? <CaretDown size={13} className="text-muted shrink-0" />
          : <CaretRight size={13} className="text-muted shrink-0" />
        }
      </button>

      {/* Expanded file list */}
      {expanded && (
        <div className="px-1 pb-1.5 border-t border-subtle">
          {tool.configFiles.map((f) => {
            const fullPath = `${rootPath}/${f.relativePath}`
            return (
              <div
                key={f.relativePath}
                className="flex items-center h-6 px-2 rounded hover:bg-hover group cursor-pointer"
                onClick={() => f.exists && !f.isDirectory && window.electronAPI.shellShowInFolder(fullPath)}
                onContextMenu={async (e) => {
                  e.preventDefault()
                  const items: NativeContextMenuItem[] = []
                  if (f.exists && !f.isDirectory) {
                    items.push(
                      { id: 'open', label: 'Open in Editor' },
                      { id: 'reveal', label: 'Reveal in Finder' },
                      { type: 'separator' },
                      { id: 'delete', label: 'Delete' },
                    )
                  } else if (!f.exists && !f.isDirectory) {
                    items.push({ id: 'create', label: 'Create' })
                  }
                  if (!items.length) return
                  const id = await window.electronAPI.showContextMenu(items)
                  switch (id) {
                    case 'open': useAppStore.getState().createEditor(workspaceId, fullPath, undefined, getEditorPlacement()); break
                    case 'reveal': window.electronAPI.shellShowInFolder(fullPath); break
                    case 'delete': await window.electronAPI.fsDelete(fullPath); scan(rootPath); break
                    case 'create': createConfig(tool.id, f.relativePath, rootPath); break
                  }
                }}
              >
                {f.exists ? (
                  <Check size={10} className="text-muted shrink-0 mr-1.5" />
                ) : (
                  <button onClick={(e) => { e.stopPropagation(); createConfig(tool.id, f.relativePath, rootPath) }} className="text-muted hover:text-secondary shrink-0 mr-1.5">
                    <Plus size={10} />
                  </button>
                )}
                <span className={`text-[10px] font-mono flex-1 truncate ${f.exists ? 'text-secondary' : 'text-muted'}`}>
                  {f.relativePath}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// Add agent sub-view (full page replacement)
// =============================================================================

function AddAgentView({ rootPath, unconfiguredTools, onBack }: {
  rootPath: string; unconfiguredTools: AIToolPresence[]; onBack: () => void
}) {
  const [busy, setBusy] = useState<AIToolId | null>(null)
  const createAllForTool = useAIConfigStore((s) => s.createAllForTool)

  return (
    <div className="flex flex-col h-full">
      <SidebarSectionHeader
        title="Add Agent"
        actions={
          <SidebarHeaderButton onClick={onBack} title="Back" className="text-secondary hover:text-primary text-[13px] leading-none">
            <span className="px-1">&larr;</span>
          </SidebarHeaderButton>
        }
      />
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {unconfiguredTools.map((tool) => {
          const Logo = TOOL_LOGOS[tool.id]
          return (
            <button
              key={tool.id}
              onClick={async () => { setBusy(tool.id); await createAllForTool(tool.id, rootPath); setBusy(null); onBack() }}
              disabled={busy !== null}
              className="w-full flex items-center gap-3 px-3 py-3.5 rounded-md bg-surface-5 border border-subtle hover:bg-hover hover:border-subtle transition-all disabled:opacity-50"
            >
              <div className="w-8 h-8 rounded-md bg-surface-5 flex items-center justify-center shrink-0 text-secondary">
                <Logo size={16} />
              </div>
              <div className="flex-1 text-left">
                <div className="text-[13px] text-primary font-medium">{tool.name}</div>
                <div className="text-[11px] text-muted">{tool.configFiles.length} config files</div>
              </div>
              {busy === tool.id && <CircleNotch size={14} className="text-muted animate-spin shrink-0" />}
            </button>
          )
        })}
        {unconfiguredTools.length === 0 && (
          <div className="text-[12px] text-muted py-4 text-center">All agents are configured</div>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// Skills card (sticky bottom)
// =============================================================================

async function installSkill(rootPath: string, filename: string, content: string) {
  for (const dest of SKILL_DESTINATIONS) {
    try { await window.electronAPI.fsStat(`${rootPath}/${dest}`); await window.electronAPI.fsWriteFile(`${rootPath}/${dest}/${filename}`, content) } catch {}
  }
  await window.electronAPI.fsWriteFile(`${rootPath}/.claude/skills/${filename}`, content)
}

interface RemoteSkill { name: string; path: string; downloadUrl: string; type: 'file' | 'dir' }

async function scanGitHubDir(owner: string, repo: string, dirPath: string, branch?: string): Promise<RemoteSkill[]> {
  const ref = branch ? `?ref=${branch}` : ''
  const res = await window.electronAPI.httpFetch(`https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}${ref}`)
  if (!res.ok) return []
  try {
    const items = JSON.parse(res.text)
    if (!Array.isArray(items)) return []
    return items.filter((i: any) => i.type === 'file' && i.name?.endsWith('.md') || i.type === 'dir')
      .map((i: any) => ({ name: i.name + (i.type === 'dir' ? '/' : ''), path: i.path, downloadUrl: i.download_url || '', type: i.type }))
  } catch { return [] }
}

async function downloadGitHubDir(owner: string, repo: string, dirPath: string, rootPath: string, destDir: string, branch?: string) {
  const ref = branch ? `?ref=${branch}` : ''
  const res = await window.electronAPI.httpFetch(`https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}${ref}`)
  if (!res.ok) return
  try {
    const items = JSON.parse(res.text)
    if (!Array.isArray(items)) return
    for (const item of items) {
      if (item.type === 'file' && item.download_url) {
        const fileRes = await window.electronAPI.httpFetch(item.download_url)
        if (fileRes.ok) await window.electronAPI.fsWriteFile(`${rootPath}/${destDir}/${item.name}`, fileRes.text)
      } else if (item.type === 'dir') {
        await downloadGitHubDir(owner, repo, item.path, rootPath, `${destDir}/${item.name}`, branch)
      }
    }
  } catch {}
}

function SkillsCard({ rootPath, workspaceId }: {
  rootPath: string; workspaceId: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [skills, setSkills] = useState<{ name: string; displayName: string; desc: string; isDir: boolean }[]>([])
  const [loading, setLoading] = useState(false)
  const [showUrl, setShowUrl] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [url, setUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [remoteSkills, setRemoteSkills] = useState<RemoteSkill[]>([])
  const [repoInfo, setRepoInfo] = useState<{ owner: string; repo: string; branch?: string } | null>(null)
  const scan = useAIConfigStore((s) => s.scan)

  const loadSkills = useCallback(async () => {
    setLoading(true)
    try {
      const entries = await window.electronAPI.fsReadDir(`${rootPath}/.claude/skills`)
      const items = (entries as any[]).filter((e: any) => e.isDirectory || e.name?.endsWith('.md'))
      const data = await Promise.all(items.map(async (e: any) => {
        if (e.isDirectory) return { name: e.name, displayName: e.name, desc: 'Skill folder', isDir: true }
        try {
          const content = await window.electronAPI.fsReadFile(`${rootPath}/.claude/skills/${e.name}`)
          let displayName = e.name.replace('.md', ''), desc = ''
          const fm = content.match(/^---\n([\s\S]*?)\n---/)
          if (fm) {
            const n = fm[1].match(/^name:\s*(.+)$/m), d = fm[1].match(/^description:\s*(.+)$/m)
            if (n) displayName = n[1].trim(); if (d) desc = d[1].trim()
          }
          return { name: e.name, displayName, desc, isDir: false }
        } catch { return { name: e.name, displayName: e.name.replace('.md', ''), desc: '', isDir: false } }
      }))
      setSkills(data)
    } catch { setSkills([]) }
    setLoading(false)
  }, [rootPath])

  useEffect(() => { if (expanded) loadSkills() }, [expanded, loadSkills])

  const handleImport = useCallback(async () => {
    if (!url.trim()) return
    setImporting(true); setMsg(null); setRemoteSkills([]); setRepoInfo(null)
    try {
      const input = url.trim().replace(/\/$/, '')
      const repoMatch = input.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/)
      const treeMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?/)
      const blobMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)/)

      if (blobMatch) {
        const [, owner, repo, branch, filePath] = blobMatch
        const res = await window.electronAPI.httpFetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`)
        if (!res.ok) throw new Error(`Could not fetch (HTTP ${res.status})`)
        const filename = filePath.split('/').pop() || 'imported.md'
        await installSkill(rootPath, filename.endsWith('.md') ? filename : `${filename}.md`, res.text)
        setUrl(''); setShowUrl(false); setMsg({ text: `Imported ${filename}`, ok: true }); loadSkills()
        setTimeout(() => setMsg(null), 3000)
      } else if (treeMatch || repoMatch) {
        const owner = (treeMatch || repoMatch)![1]
        const repo = (treeMatch || repoMatch)![2]
        const branch = treeMatch?.[3]
        const subPath = treeMatch?.[4]
        const searchPaths = subPath ? [subPath] : ['.claude/skills', 'skills', '.cursor/rules']
        let found: RemoteSkill[] = []
        for (const sp of searchPaths) { found = await scanGitHubDir(owner, repo, sp, branch); if (found.length > 0) break }
        if (found.length === 0) throw new Error('No skills found in repo')
        setRemoteSkills(found); setRepoInfo({ owner, repo, branch })
        setMsg({ text: `Found ${found.length} skills`, ok: true })
      } else if (input.startsWith('http')) {
        const res = await window.electronAPI.httpFetch(input)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        if (res.text.trim().startsWith('<!DOCTYPE')) throw new Error('Got HTML, need a raw file URL')
        const parts = input.split('/'); let fn = (parts[parts.length - 1] || 'skill').replace(/[^a-zA-Z0-9._-]/g, '')
        if (!fn.endsWith('.md')) fn += '.md'
        await installSkill(rootPath, fn, res.text)
        setUrl(''); setShowUrl(false); setMsg({ text: `Imported ${fn}`, ok: true }); loadSkills()
        setTimeout(() => setMsg(null), 3000)
      } else { throw new Error('Paste a GitHub URL or direct .md link') }
    } catch (err: any) { setMsg({ text: err.message || 'Failed', ok: false }) }
    setImporting(false)
  }, [url, rootPath, loadSkills])

  const handleImportRemote = useCallback(async (skill: RemoteSkill) => {
    if (!repoInfo) return; setImporting(true)
    try {
      if (skill.type === 'file' && skill.downloadUrl) {
        const res = await window.electronAPI.httpFetch(skill.downloadUrl)
        if (res.ok) await installSkill(rootPath, skill.name, res.text)
      } else if (skill.type === 'dir') {
        await downloadGitHubDir(repoInfo.owner, repoInfo.repo, skill.path, rootPath, `.claude/skills/${skill.name.replace('/', '')}`, repoInfo.branch)
      }
      setMsg({ text: `Imported ${skill.name}`, ok: true }); loadSkills(); setTimeout(() => setMsg(null), 3000)
    } catch (err: any) { setMsg({ text: err.message, ok: false }) }
    setImporting(false)
  }, [repoInfo, rootPath, loadSkills])

  const handleImportAll = useCallback(async () => {
    if (!repoInfo) return; setImporting(true)
    for (const skill of remoteSkills) {
      try {
        if (skill.type === 'file' && skill.downloadUrl) { const r = await window.electronAPI.httpFetch(skill.downloadUrl); if (r.ok) await installSkill(rootPath, skill.name, r.text) }
        else if (skill.type === 'dir') await downloadGitHubDir(repoInfo.owner, repoInfo.repo, skill.path, rootPath, `.claude/skills/${skill.name.replace('/', '')}`, repoInfo.branch)
      } catch {}
    }
    setMsg({ text: `Imported ${remoteSkills.length} skills`, ok: true }); setRemoteSkills([]); setRepoInfo(null); setUrl(''); setShowUrl(false)
    loadSkills(); setTimeout(() => setMsg(null), 3000); setImporting(false)
  }, [repoInfo, remoteSkills, rootPath, loadSkills])

  const handleCreate = useCallback(async () => {
    const safe = (newName.trim() || 'new-skill').replace(/[^a-zA-Z0-9._-]/g, '-')
    const fn = safe.endsWith('.md') ? safe : `${safe}.md`
    await installSkill(rootPath, fn, `---\nname: ${safe}\ndescription: Describe what this skill does\n---\n\n# Skill Instructions\n\nAdd your skill instructions here.\n`)
    useAppStore.getState().createEditor(workspaceId, `${rootPath}/.claude/skills/${fn}`, undefined, getEditorPlacement())
    setNewName(''); setShowNew(false); loadSkills()
  }, [newName, rootPath, workspaceId, loadSkills])

  const handleDelete = useCallback(async (name: string) => {
    for (const dest of SKILL_DESTINATIONS) try { await window.electronAPI.fsDelete(`${rootPath}/${dest}/${name}`) } catch {}
    loadSkills(); scan(rootPath)
  }, [rootPath, loadSkills, scan])

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault(); setDragOver(false)
    for (const file of Array.from(e.dataTransfer.files)) if (file.name.endsWith('.md')) await installSkill(rootPath, file.name, await file.text())
    const text = e.dataTransfer.getData('text/plain')
    if (text?.startsWith('http')) { setUrl(text); setShowUrl(true) }
    loadSkills()
  }, [rootPath, loadSkills])

  return (
    <div
      className="rounded-md bg-surface-5 border border-subtle overflow-hidden"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-hover transition-colors">
        <BookOpen size={14} className="text-muted shrink-0" />
        <span className="text-[12px] text-secondary flex-1 text-left">Skills</span>
        {skills.length > 0 && <span className="text-[10px] text-muted">{skills.length}</span>}
        {expanded ? <CaretDown size={11} className="text-muted" /> : <CaretRight size={11} className="text-muted" />}
      </button>

      {expanded && (
        <div className={`border-t border-subtle ${dragOver ? 'bg-surface-5' : ''}`}>
          {dragOver ? (
            <div className="flex items-center justify-center py-4 text-[11px] text-secondary"><Download size={12} className="mr-1" /> Drop .md files</div>
          ) : (
            <div className="px-1 pb-1.5">
              {loading && <div className="text-[11px] text-muted px-2 py-2">Scanning...</div>}
              {!loading && skills.length === 0 && !showUrl && <div className="text-[11px] text-muted px-2 py-2">No skills found</div>}

              {skills.map((s) => (
                <div key={s.name}
                  className="flex items-center h-6 px-2 rounded hover:bg-hover group cursor-pointer"
                  onClick={() => window.electronAPI.shellShowInFolder(`${rootPath}/.claude/skills/${s.name}`)}
                  onContextMenu={async (e) => {
                    e.preventDefault()
                    const items: NativeContextMenuItem[] = [
                      { id: 'open', label: 'Open in Editor' },
                      { id: 'reveal', label: 'Reveal in Finder' },
                      { type: 'separator' },
                      { id: 'delete', label: 'Delete' },
                    ]
                    const id = await window.electronAPI.showContextMenu(items)
                    switch (id) {
                      case 'open': useAppStore.getState().createEditor(workspaceId, `${rootPath}/.claude/skills/${s.name}`, undefined, getEditorPlacement()); break
                      case 'reveal': window.electronAPI.shellShowInFolder(`${rootPath}/.claude/skills/${s.name}`); break
                      case 'delete': handleDelete(s.name); break
                    }
                  }}
                >
                  <span className="text-[10px] text-secondary flex-1 truncate">{s.displayName}</span>
                  {s.desc && <span className="text-[9px] text-muted truncate max-w-[80px] ml-1">{s.desc}</span>}
                </div>
              ))}

              {msg && <div className={`text-[10px] px-2 py-1 ${msg.ok ? 'text-emerald-400/70' : 'text-red-400/70'}`}>{msg.text}</div>}

              {showUrl && (
                <div className="px-2 pt-1.5">
                  <div className="flex items-center gap-1">
                    <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleImport()}
                      placeholder="GitHub repo or file URL" className={INPUT_CLS} autoFocus />
                    <button onClick={handleImport} disabled={!url.trim() || importing} className="text-[10px] text-secondary hover:text-primary disabled:opacity-30 shrink-0">
                      {importing ? <CircleNotch size={10} className="animate-spin" /> : 'Scan'}
                    </button>
                    <button onClick={() => { setShowUrl(false); setUrl(''); setRemoteSkills([]); setRepoInfo(null) }} className="text-muted shrink-0"><X size={10} /></button>
                  </div>
                  {remoteSkills.length > 0 && (
                    <div className="mt-1.5">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] text-muted flex-1">Found in repo</span>
                        <button onClick={handleImportAll} disabled={importing} className="text-[10px] text-secondary hover:text-primary disabled:opacity-30">Import all</button>
                      </div>
                      <div className="max-h-24 overflow-y-auto">
                        {remoteSkills.map((rs) => (
                          <div key={rs.path} className="flex items-center h-5 gap-1 group">
                            <span className="text-[10px] text-secondary flex-1 truncate font-mono">{rs.name}</span>
                            <button onClick={() => handleImportRemote(rs)} disabled={importing}
                              className="text-[9px] text-muted hover:text-primary opacity-0 group-hover:opacity-100 disabled:opacity-30 shrink-0">Import</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {showNew && (
                <div className="flex items-center gap-1 px-2 pt-1.5">
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                    placeholder="skill-name" className={INPUT_CLS} autoFocus />
                  <button onClick={handleCreate} className="text-[10px] text-secondary hover:text-primary shrink-0">OK</button>
                  <button onClick={() => { setShowNew(false); setNewName('') }} className="text-muted shrink-0"><X size={10} /></button>
                </div>
              )}

              {!showUrl && !showNew && (
                <div className="flex items-center gap-2 px-2 pt-1.5">
                  <button onClick={() => setShowNew(true)} className="text-[10px] text-muted hover:text-primary">+ New</button>
                  <button onClick={() => setShowUrl(true)} className="text-[10px] text-muted hover:text-primary">Import</button>
                  <span className="text-[9px] text-muted">or drop .md</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// MCP card (sticky bottom)
// =============================================================================

function MCPCard({ rootPath }: { rootPath: string }) {
  const [expanded, setExpanded] = useState(false)
  const mcpServers = useAIConfigStore((s) => s.mcpServers)
  const load = useAIConfigStore((s) => s.loadMcpServers)
  const spawn = useAIConfigStore((s) => s.spawnMcpServer)
  const stop = useAIConfigStore((s) => s.stopMcpServer)
  const remove = useAIConfigStore((s) => s.removeMcpServer)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingServer, setEditingServer] = useState<MCPServerDefinition | undefined>(undefined)
  const [showReg, setShowReg] = useState(false)

  useEffect(() => { if (expanded) load(rootPath) }, [expanded, rootPath, load])
  const servers = Object.values(mcpServers)

  const openAdd = () => { setEditingServer(undefined); setEditorOpen(true) }
  const openEdit = (s: MCPServerConfig) => {
    setEditingServer({ name: s.name, command: s.command, args: s.args, env: s.env })
    setEditorOpen(true)
  }

  return (
    <div className="rounded-md bg-surface-5 border border-subtle overflow-hidden">
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-hover transition-colors">
        <HardDrives size={14} className="text-muted shrink-0" />
        <span className="text-[12px] text-secondary flex-1 text-left">MCP Servers</span>
        {servers.length > 0 && <span className="text-[10px] text-muted">{servers.length}</span>}
        {expanded ? <CaretDown size={11} className="text-muted" /> : <CaretRight size={11} className="text-muted" />}
      </button>

      {expanded && (
        <div className="border-t border-subtle px-1 pb-1.5">
          {servers.map((s) => {
            const dot = s.status === 'running' ? 'bg-emerald-400' : s.status === 'error' ? 'bg-red-400' : s.status === 'starting' ? 'bg-amber-400 animate-pulse' : 'bg-surface-6'
            return (
              <div key={s.name} className="flex items-center h-6 px-2 rounded hover:bg-hover group">
                <div className={`w-1.5 h-1.5 rounded-full shrink-0 mr-1.5 ${dot}`} />
                <span className="text-[10px] text-secondary flex-1 truncate">{s.name}</span>
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {s.status === 'running'
                    ? <button onClick={() => stop(s.name)} className="p-0.5 text-muted hover:text-primary" title="Stop"><Square size={9} /></button>
                    : <button onClick={() => spawn(s.name)} className="p-0.5 text-muted hover:text-primary" title="Start"><Play size={9} /></button>
                  }
                  <button onClick={() => openEdit(s)} className="p-0.5 text-muted hover:text-primary" title="Edit"><PencilSimple size={9} /></button>
                  <button onClick={() => remove(s.name, rootPath)} className="p-0.5 text-muted hover:text-red-400" title="Delete"><Trash size={9} /></button>
                </div>
              </div>
            )
          })}
          {servers.length === 0 && <div className="text-[11px] text-muted px-2 py-2">None configured</div>}

          <div className="flex gap-3 px-2 pt-1.5">
            <button onClick={openAdd} className="text-[10px] text-muted hover:text-primary">+ Add</button>
            <button onClick={() => setShowReg(!showReg)} className="text-[10px] text-muted hover:text-primary">{showReg ? 'Hide' : 'Browse'}</button>
          </div>

          {showReg && (() => {
            const Reg = () => {
              const [q, setQ] = useState('')
              const add = useAIConfigStore((s) => s.addMcpServer)
              const existing = useAIConfigStore((s) => s.mcpServers)
              const results = searchRegistry(q)
              return (
                <div className="px-2 pt-1.5">
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search..." className={INPUT_CLS} />
                  <div className="mt-1 max-h-28 overflow-y-auto">
                    {results.map((entry) => {
                      const key = entry.name.toLowerCase().replace(/\s+/g, '-')
                      return (
                        <div key={entry.name} className="flex items-center h-5 gap-1">
                          <span className="text-[10px] text-secondary flex-1 truncate">{entry.name}</span>
                          {existing[key] ? <span className="text-[9px] text-muted">added</span>
                            : <button onClick={() => add({ name: key, command: entry.command, args: entry.args, env: {} }, rootPath)} className="text-[9px] text-secondary hover:text-primary">Add</button>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            }
            return <Reg />
          })()}
        </div>
      )}

      {editorOpen && (
        <MCPServerEditor
          rootPath={rootPath}
          editingServer={editingServer}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  )
}

// =============================================================================
// Main component
// =============================================================================

export const AIConfigSidebarView: React.FC<{ rootPath: string; workspaceId: string }> = ({ rootPath, workspaceId }) => {
  const tools = useAIConfigStore((s) => s.tools)
  const scanning = useAIConfigStore((s) => s.scanning)
  const scan = useAIConfigStore((s) => s.scan)
  const watch = useAIConfigStore((s) => s.watchConfigFiles)
  const [subPage, setSubPage] = useState<'main' | 'addAgent'>('main')

  useEffect(() => { if (rootPath) scan(rootPath) }, [rootPath]) // eslint-disable-line
  useEffect(() => { if (!rootPath) return; return watch(rootPath) }, [rootPath, watch])

  if (!rootPath) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted text-[12px] gap-3 p-4">
        <FolderOpen size={20} className="text-muted" />
        <span>No folder open</span>
        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded text-secondary hover:text-primary bg-surface-5 hover:bg-hover transition-colors"
          onClick={async () => { const p = await window.electronAPI.openFolderDialog(); if (p && workspaceId) useAppStore.getState().setWorkspaceRootPath(workspaceId, p) }}>
          <FolderOpen size={12} /> Open Folder
        </button>
      </div>
    )
  }

  const configuredTools = tools ? Object.values(tools).filter((t) => t.detected) : []
  const unconfiguredTools = tools ? Object.values(tools).filter((t) => !t.detected) : []

  // Sub-page: Add Agent
  if (subPage === 'addAgent') {
    return (
      <AddAgentView rootPath={rootPath} unconfiguredTools={unconfiguredTools} onBack={() => setSubPage('main')} />
    )
  }

  return (
    <div className="flex flex-col h-full">
      <SidebarSectionHeader
        title="Agent Setup"
        actions={
          <SidebarHeaderButton onClick={() => scan(rootPath)} disabled={scanning} title="Rescan" spinning={scanning}>
            <ArrowsClockwise size={12} />
          </SidebarHeaderButton>
        }
      />

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {scanning && !tools ? (
          <div className="flex items-center gap-2 py-4 px-3 text-[12px] text-muted"><CircleNotch size={12} className="animate-spin" /> Scanning...</div>
        ) : (
          <div className="p-2 space-y-2">
            {/* Tool cards */}
            {configuredTools.length === 0 && (
              <div className="text-[12px] text-muted px-1 py-3">No agents configured yet</div>
            )}
            {configuredTools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} rootPath={rootPath} workspaceId={workspaceId} />
            ))}

            {/* Add agent button */}
            {unconfiguredTools.length > 0 && (
              <button
                onClick={() => setSubPage('addAgent')}
                className="w-full flex items-center justify-center gap-1.5 py-2.5 text-[12px] text-muted hover:text-secondary hover:bg-hover rounded-md border border-dashed border-subtle transition-colors"
              >
                <Plus size={13} /> Add Agent
              </button>
            )}

            {/* Skills & MCP cards */}
            <SkillsCard rootPath={rootPath} workspaceId={workspaceId} />
            <MCPCard rootPath={rootPath} />
          </div>
        )}
      </div>
    </div>
  )
}
