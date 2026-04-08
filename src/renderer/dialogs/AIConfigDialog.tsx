// =============================================================================
// AIConfigDialog — AI tool configuration.
// Users toggle tools on/off; config files managed automatically.
// Skills can be added from URL, drag-drop, or template.
// =============================================================================

import React, { useEffect, useCallback, useState, useRef, type DragEvent } from 'react'
import log from '../lib/logger'
import {
  Sparkle, Cpu, Diamond, CursorClick, Code,
  X, Plus, Trash, Play, Square, Lightning,
  ArrowsClockwise, FolderOpen, CircleNotch, Eye, EyeSlash,
  ArrowSquareOut, Download, Link, Check,
} from '@phosphor-icons/react'
import type { Icon as LucideIcon } from '@phosphor-icons/react'
import type { AIToolId, AIToolPresence, MCPServerConfig } from '../../shared/types'
import { useAIConfigStore } from '../stores/aiConfigStore'
import { useAppStore } from '../stores/appStore'
import { searchRegistry, type MCPRegistryEntry } from '../lib/aiConfig/mcpRegistry'
import type { NativeContextMenuItem } from '../../shared/electron-api'

// =============================================================================
// Types & constants
// =============================================================================

interface AIConfigDialogProps {
  isOpen: boolean
  onClose: () => void
  workspaceId: string
}

type Tab = 'configs' | 'skills' | 'mcp'

const TOOL_ICONS: Record<string, LucideIcon> = {
  Sparkles: Sparkle, Cpu, Diamond, MousePointer: CursorClick, Code,
}

const INPUT_CLS = 'w-full bg-surface-5 border border-subtle rounded px-2.5 py-1.5 text-[13px] text-primary placeholder:text-muted focus:border-strong focus:outline-none font-mono'

// All known skill destinations across tools
const SKILL_DESTINATIONS = [
  '.claude/skills',
  '.cursor/rules',
] as const

// =============================================================================
// AI Configs tab
// =============================================================================

function ConfigsContent({ tools, rootPath, workspaceId }: {
  tools: Record<AIToolId, AIToolPresence>
  rootPath: string
  workspaceId: string
}) {
  const createAllForTool = useAIConfigStore((s) => s.createAllForTool)
  const scan = useAIConfigStore((s) => s.scan)

  const toolList = Object.values(tools) as AIToolPresence[]
  const anyConfigured = toolList.some((t) => t.detected)

  const handleQuickSetup = useCallback(async (ids: AIToolId[]) => {
    await Promise.all(ids.map((id) => createAllForTool(id, rootPath)))
  }, [createAllForTool, rootPath])

  return (
    <div>
      {/* Quick setup templates — shown only when nothing is configured */}
      {!anyConfigured && (
        <div className="flex items-center gap-2 pb-3 mb-3 border-b border-subtle">
          <span className="text-[12px] text-muted shrink-0">Quick setup:</span>
          <button
            onClick={() => handleQuickSetup(['claude', 'codex', 'cursor'] as AIToolId[])}
            className="px-2 py-0.5 text-[12px] text-secondary hover:text-primary border border-subtle hover:border-strong rounded transition-colors"
          >
            Full Stack
          </button>
          <button
            onClick={() => handleQuickSetup(['claude', 'codex'] as AIToolId[])}
            className="px-2 py-0.5 text-[12px] text-secondary hover:text-primary border border-subtle hover:border-strong rounded transition-colors"
          >
            Python
          </button>
          <button
            onClick={() => handleQuickSetup(['claude'] as AIToolId[])}
            className="px-2 py-0.5 text-[12px] text-secondary hover:text-primary border border-subtle hover:border-strong rounded transition-colors"
          >
            Minimal
          </button>
        </div>
      )}

      {toolList.map((tool) => (
        <ToolRow key={tool.id} tool={tool} rootPath={rootPath} workspaceId={workspaceId} onRescan={() => scan(rootPath)} />
      ))}
    </div>
  )
}

function ToolRow({ tool, rootPath, workspaceId, onRescan }: {
  tool: AIToolPresence
  rootPath: string
  workspaceId: string
  onRescan: () => void
}) {
  const [busy, setBusy] = useState(false)
  const createAllForTool = useAIConfigStore((s) => s.createAllForTool)
  const createConfig = useAIConfigStore((s) => s.createConfig)
  const Icon = TOOL_ICONS[tool.icon]

  const handleEnable = useCallback(async () => {
    setBusy(true)
    try { await createAllForTool(tool.id, rootPath) }
    catch (e) { log.error(e) }
    finally { setBusy(false) }
  }, [createAllForTool, tool.id, rootPath])

  const handleCreateFile = useCallback(async (relativePath: string) => {
    setBusy(true)
    try { await createConfig(tool.id, relativePath, rootPath) }
    catch (e) { log.error(e) }
    finally { setBusy(false) }
  }, [createConfig, tool.id, rootPath])

  const handleRowContextMenu = useCallback(async (e: React.MouseEvent, relativePath: string, exists: boolean) => {
    e.preventDefault()
    e.stopPropagation()
    const fullPath = `${rootPath}/${relativePath}`
    const items: NativeContextMenuItem[] = [
      { id: 'open', label: 'Open in Editor' },
      { id: 'reveal', label: 'Reveal in Finder' },
    ]
    if (exists) {
      items.push({ type: 'separator' })
      items.push({ id: 'delete', label: 'Delete' })
    }
    const id = await window.electronAPI.showContextMenu(items)
    switch (id) {
      case 'open': useAppStore.getState().createEditor(workspaceId, fullPath); break
      case 'reveal': window.electronAPI.shellShowInFolder(fullPath); break
      case 'delete': await window.electronAPI.fsDelete(fullPath); onRescan(); break
    }
  }, [rootPath, workspaceId, onRescan])

  // All files (existing + missing), skipping directory entries
  const nonDirFiles = tool.configFiles.filter((f) => !f.isDirectory)
  const existCount = nonDirFiles.filter((f) => f.exists).length
  const fileCount = nonDirFiles.length

  return (
    <div className="border-b border-subtle last:border-b-0">
      <div className="flex items-center h-9 px-1 gap-3">
        {Icon && <Icon size={15} className="text-muted shrink-0" />}
        <span className="text-[13px] text-primary flex-1">{tool.name}</span>

        {busy ? (
          <CircleNotch size={13} className="text-muted animate-spin" />
        ) : !tool.detected ? (
          <button onClick={handleEnable} className="text-[12px] text-secondary hover:text-primary transition-colors">
            Enable
          </button>
        ) : existCount < fileCount ? (
          <button onClick={handleEnable} className="text-[12px] text-secondary hover:text-primary transition-colors">
            {existCount}/{fileCount}
          </button>
        ) : (
          <span className="text-[12px] text-muted">enabled</span>
        )}
      </div>

      {/* Show all files (existing and missing) when tool is detected */}
      {tool.detected && nonDirFiles.length > 0 && (
        <div className="pb-1.5">
          {nonDirFiles.map((f) => {
            const fullPath = `${rootPath}/${f.relativePath}`
            return (
              <button
                key={f.relativePath}
                onClick={() => {
                  if (f.exists) {
                    window.electronAPI.shellShowInFolder(fullPath)
                  } else {
                    handleCreateFile(f.relativePath)
                  }
                }}
                onContextMenu={(e) => handleRowContextMenu(e, f.relativePath, f.exists)}
                className="flex items-center h-7 pl-9 pr-2 gap-2 w-full text-left hover:bg-hover transition-colors group"
              >
                {f.exists ? (
                  <Check size={11} className="text-muted shrink-0" />
                ) : (
                  <Plus size={11} className="text-muted shrink-0" />
                )}
                <span className={`text-[12px] font-mono flex-1 truncate ${f.exists ? 'text-secondary' : 'text-muted'}`}>
                  {f.relativePath}
                </span>
                {f.exists && (
                  <ArrowSquareOut size={11} className="text-white/0 group-hover:text-muted transition-colors shrink-0" />
                )}
              </button>
            )
          })}
        </div>
      )}

    </div>
  )
}

// =============================================================================
// Skills tab — add from URL, drag-drop, template
// =============================================================================

async function installSkillContent(rootPath: string, filename: string, content: string) {
  // Write to all relevant tool skill directories that exist
  for (const dest of SKILL_DESTINATIONS) {
    const dir = `${rootPath}/${dest}`
    try {
      await window.electronAPI.fsStat(dir)
      await window.electronAPI.fsWriteFile(`${dir}/${filename}`, content)
    } catch {
      // Directory doesn't exist — skip this destination
    }
  }
  // Always ensure .claude/skills exists and write there
  await window.electronAPI.fsWriteFile(`${rootPath}/.claude/skills/${filename}`, content)
}

interface SkillEntry {
  name: string
  displayName: string
  description: string
}

function SkillsContent({ rootPath, workspaceId }: { rootPath: string; workspaceId: string }) {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showUrlInput, setShowUrlInput] = useState(false)
  const [url, setUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importSuccess, setImportSuccess] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [showNewSkillInput, setShowNewSkillInput] = useState(false)
  const [newSkillName, setNewSkillName] = useState('')
  const dropRef = useRef<HTMLDivElement>(null)
  const newSkillInputRef = useRef<HTMLInputElement>(null)

  const loadSkills = useCallback(async () => {
    setLoading(true)
    try {
      const entries = await window.electronAPI.fsReadDir(`${rootPath}/.claude/skills`)
      const mdFiles = (entries as any[])
        .filter((e: any) => e.name?.endsWith('.md') && !e.isDirectory)
        .map((e: any) => e.name)

      const skillData = await Promise.all(
        mdFiles.map(async (name: string) => {
          try {
            const content = await window.electronAPI.fsReadFile(`${rootPath}/.claude/skills/${name}`)
            const lines = content.split('\n')

            // Extract name from frontmatter if available
            let displayName = name.replace('.md', '')
            let description = ''
            let inFrontmatter = false
            let pastFrontmatter = false

            for (const line of lines) {
              if (!pastFrontmatter && line.trim() === '---') {
                if (!inFrontmatter) { inFrontmatter = true; continue }
                else { inFrontmatter = false; pastFrontmatter = true; continue }
              }
              if (inFrontmatter) {
                const nameMatch = line.match(/^name:\s*(.+)/)
                if (nameMatch) displayName = nameMatch[1].trim()
                const descMatch = line.match(/^description:\s*(.+)/)
                if (descMatch) description = descMatch[1].trim()
                continue
              }
              if (pastFrontmatter && line.trim() && !line.startsWith('#') && !description) {
                description = line.trim()
                break
              }
            }

            return { name, displayName, description }
          } catch {
            return { name, displayName: name.replace('.md', ''), description: '' }
          }
        }),
      )
      setSkills(skillData)
    } catch {
      setSkills([])
    }
    setLoading(false)
  }, [rootPath])

  useEffect(() => { loadSkills() }, [loadSkills])

  useEffect(() => {
    if (showNewSkillInput) newSkillInputRef.current?.focus()
  }, [showNewSkillInput])

  const handleSkillContextMenu = useCallback(async (e: React.MouseEvent, skillName: string) => {
    e.preventDefault()
    e.stopPropagation()
    const fullPath = `${rootPath}/.claude/skills/${skillName}`
    const items: NativeContextMenuItem[] = [
      { id: 'open', label: 'Open in Editor' },
      { id: 'reveal', label: 'Reveal in Finder' },
      { type: 'separator' },
      { id: 'delete', label: 'Delete' },
    ]
    const id = await window.electronAPI.showContextMenu(items)
    switch (id) {
      case 'open': useAppStore.getState().createEditor(workspaceId, fullPath); break
      case 'reveal': window.electronAPI.shellShowInFolder(fullPath); break
      case 'delete':
        try { await window.electronAPI.fsDelete(fullPath) } catch { /* ignore */ }
        try {
          const cursorPath = `${rootPath}/.cursor/rules/${skillName}`
          await window.electronAPI.fsDelete(cursorPath)
        } catch { /* not there */ }
        loadSkills()
        break
    }
  }, [rootPath, workspaceId, loadSkills])

  const handleReveal = useCallback((name: string) => {
    window.electronAPI.shellShowInFolder(`${rootPath}/.claude/skills/${name}`)
  }, [rootPath])

  const handleCreateNewSkill = useCallback(async () => {
    const rawName = newSkillName.trim()
    if (!rawName) return
    const safeName = rawName.endsWith('.md') ? rawName : `${rawName}.md`
    const slugName = rawName.replace(/\.md$/, '')
    const content = `---
name: ${slugName}
description: Describe what this skill does
---

# Skill Instructions

Add your skill instructions here. This skill will be available to AI coding tools.
`
    await installSkillContent(rootPath, safeName, content)
    useAppStore.getState().createEditor(workspaceId, `${rootPath}/.claude/skills/${safeName}`)
    setNewSkillName('')
    setShowNewSkillInput(false)
    loadSkills()
  }, [newSkillName, rootPath, workspaceId, loadSkills])

  const handleImportUrl = useCallback(async () => {
    if (!url.trim()) return
    setImporting(true)
    setImportError(null)
    setImportSuccess(false)
    try {
      // Convert GitHub URLs to raw content URLs
      let fetchUrl = url.trim()
      if (fetchUrl.includes('github.com') && fetchUrl.includes('/blob/')) {
        fetchUrl = fetchUrl
          .replace('github.com', 'raw.githubusercontent.com')
          .replace('/blob/', '/')
      }

      const response = await window.electronAPI.httpFetch(fetchUrl)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const content = response.text

      const urlParts = fetchUrl.split('/')
      const filename = urlParts[urlParts.length - 1] || 'imported-skill.md'
      const safeName = filename.endsWith('.md') ? filename : `${filename}.md`

      await installSkillContent(rootPath, safeName, content)
      setUrl('')
      setShowUrlInput(false)
      setImportSuccess(true)
      setTimeout(() => setImportSuccess(false), 2500)
      loadSkills()
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed')
    }
    setImporting(false)
  }, [url, rootPath, loadSkills])

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)

    const files = Array.from(e.dataTransfer.files)
    for (const file of files) {
      if (file.name.endsWith('.md')) {
        const content = await file.text()
        await installSkillContent(rootPath, file.name, content)
      }
    }

    // Also handle text/URL drops
    const text = e.dataTransfer.getData('text/plain')
    if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
      setUrl(text)
      setShowUrlInput(true)
    }

    loadSkills()
  }, [rootPath, loadSkills])

  if (loading) {
    return <div className="text-[13px] text-muted py-3 px-1">Scanning skills...</div>
  }

  return (
    <div
      ref={dropRef}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={`min-h-[200px] transition-colors ${dragOver ? 'bg-surface-5 rounded' : ''}`}
    >
      {dragOver ? (
        <div className="flex items-center justify-center py-8 text-[13px] text-secondary">
          <Download size={16} className="mr-2" />
          Drop .md skill files here
        </div>
      ) : (
        <>
          {skills.length === 0 ? (
            <div className="text-[13px] text-muted py-3 px-1">
              No skills found. Add skills from a URL, drag .md files here, or create a new one.
            </div>
          ) : (
            skills.map((skill) => (
              <button
                key={skill.name}
                onClick={() => handleReveal(skill.name)}
                onContextMenu={(e) => handleSkillContextMenu(e, skill.name)}
                className="flex items-center h-9 px-1 border-b border-subtle w-full text-left hover:bg-hover transition-colors group"
              >
                <span className="text-[13px] text-primary truncate">{skill.displayName}</span>
                {skill.description && (
                  <span className="text-[11px] text-muted truncate ml-2 flex-1">{skill.description}</span>
                )}
              </button>
            ))
          )}

          {/* Import success/error feedback */}
          {importSuccess && (
            <div className="flex items-center gap-1.5 py-2 px-1 text-[12px] text-emerald-400/80">
              <Check size={12} /> Skill imported
            </div>
          )}
          {importError && (
            <div className="py-2 px-1 text-[12px] text-red-400/80">{importError}</div>
          )}

          {/* Inline new skill name input */}
          {showNewSkillInput && (
            <div className="flex items-center gap-2 pt-3 px-1">
              <input
                ref={newSkillInputRef}
                value={newSkillName}
                onChange={(e) => setNewSkillName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateNewSkill()
                  if (e.key === 'Escape') { setShowNewSkillInput(false); setNewSkillName('') }
                }}
                placeholder="skill-name"
                className={INPUT_CLS}
              />
              <button
                onClick={handleCreateNewSkill}
                disabled={!newSkillName.trim()}
                className="text-[12px] text-secondary hover:text-primary disabled:opacity-30 shrink-0"
              >
                Create
              </button>
              <button
                onClick={() => { setShowNewSkillInput(false); setNewSkillName('') }}
                className="text-[12px] text-muted hover:text-secondary shrink-0"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Import from URL input */}
          {showUrlInput && (
            <div className="flex items-center gap-2 pt-3 px-1">
              <Link size={13} className="text-muted shrink-0" />
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleImportUrl()
                  if (e.key === 'Escape') { setShowUrlInput(false); setUrl(''); setImportError(null) }
                }}
                placeholder="GitHub URL or raw .md link"
                className={INPUT_CLS}
                autoFocus
              />
              <button
                onClick={handleImportUrl}
                disabled={!url.trim() || importing}
                className="text-[12px] text-secondary hover:text-primary disabled:opacity-30 shrink-0"
              >
                {importing ? '...' : 'Import'}
              </button>
              <button
                onClick={() => { setShowUrlInput(false); setUrl(''); setImportError(null) }}
                className="text-[12px] text-muted hover:text-secondary shrink-0"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Action row — hide individual actions when their inputs are open */}
          {!showNewSkillInput && !showUrlInput && (
            <div className="flex items-center gap-4 pt-3 px-1">
              <button
                onClick={() => setShowNewSkillInput(true)}
                className="text-[12px] text-secondary hover:text-primary transition-colors"
              >
                + New skill
              </button>
              <button
                onClick={() => { setShowUrlInput(true); setImportError(null) }}
                className="text-[12px] text-secondary hover:text-primary transition-colors"
              >
                Import from URL
              </button>
              <span className="text-[11px] text-muted">or drag .md files here</span>
            </div>
          )}
        </>
      )}

    </div>
  )
}

// =============================================================================
// MCP Servers tab
// =============================================================================

function MCPRow({ server, rootPath }: { server: MCPServerConfig; rootPath: string }) {
  const [testing, setTesting] = useState(false)
  const [testOk, setTestOk] = useState<boolean | null>(null)
  const spawn = useAIConfigStore((s) => s.spawnMcpServer)
  const stop = useAIConfigStore((s) => s.stopMcpServer)
  const remove = useAIConfigStore((s) => s.removeMcpServer)
  const test = useAIConfigStore((s) => s.testMcpServer)

  const dotColor = server.status === 'running' ? 'bg-emerald-400'
    : server.status === 'error' ? 'bg-red-400'
    : server.status === 'starting' ? 'bg-amber-400 animate-pulse'
    : 'bg-surface-6'

  return (
    <div className="border-b border-subtle last:border-b-0">
      <div className="flex items-center h-9 px-1 gap-2.5">
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
        <span className="text-[13px] text-primary flex-1 truncate">{server.name}</span>
        <span className="text-[11px] text-muted font-mono truncate max-w-[180px]">
          {server.command} {server.args[0] || ''}
        </span>

        <div className="flex items-center gap-0.5 shrink-0">
          {server.status === 'running' ? (
            <button onClick={() => stop(server.name)} className="p-1 text-muted hover:text-primary" title="Stop">
              <Square size={11} />
            </button>
          ) : (
            <button onClick={() => spawn(server.name)} className="p-1 text-muted hover:text-primary" title="Start">
              <Play size={11} />
            </button>
          )}
          <button
            onClick={async () => {
              setTesting(true); setTestOk(null)
              const r = await test(server.name)
              setTestOk(r.success); setTesting(false)
            }}
            disabled={testing}
            className="p-1 text-muted hover:text-primary disabled:opacity-30"
            title="Test"
          >
            {testing ? <CircleNotch size={11} className="animate-spin" /> : <Lightning size={11} />}
          </button>
          <button onClick={() => remove(server.name, rootPath)} className="p-1 text-muted hover:text-red-400" title="Remove">
            <Trash size={11} />
          </button>
        </div>
      </div>
      {server.error && <div className="text-[11px] text-red-400/70 pl-5 pb-1">{server.error}</div>}
      {testOk !== null && (
        <div className={`text-[11px] pl-5 pb-1 ${testOk ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
          {testOk ? 'Connection OK' : 'Connection failed'}
        </div>
      )}
    </div>
  )
}

function AddServerForm({ rootPath, onDone }: { rootPath: string; onDone: () => void }) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [envPairs, setEnvPairs] = useState<{ key: string; value: string; vis: boolean }[]>([])
  const add = useAIConfigStore((s) => s.addMcpServer)

  const handleAdd = useCallback(async () => {
    if (!name.trim() || !command.trim()) return
    const env: Record<string, string> = {}
    envPairs.forEach((p) => { if (p.key.trim()) env[p.key.trim()] = p.value })
    await add(
      { name: name.trim(), command: command.trim(), args: args.split(/\s+/).filter(Boolean), env },
      rootPath,
    )
    setName(''); setCommand(''); setArgs(''); setEnvPairs([])
    onDone()
  }, [name, command, args, envPairs, add, rootPath, onDone])

  return (
    <div className="space-y-2 pt-2">
      <div className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" className={INPUT_CLS} style={{ flex: 1 }} />
        <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="command" className={INPUT_CLS} style={{ flex: 1 }} />
      </div>
      <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="args (space-separated)" className={INPUT_CLS} />

      {envPairs.map((p, i) => (
        <div key={i} className="flex gap-1.5 items-center">
          <input value={p.key} placeholder="KEY"
            onChange={(e) => { const u = [...envPairs]; u[i] = { ...u[i], key: e.target.value }; setEnvPairs(u) }}
            className={INPUT_CLS} style={{ flex: 1 }}
          />
          <input type={p.vis ? 'text' : 'password'} value={p.value} placeholder="value"
            onChange={(e) => { const u = [...envPairs]; u[i] = { ...u[i], value: e.target.value }; setEnvPairs(u) }}
            className={INPUT_CLS} style={{ flex: 1 }}
          />
          <button onClick={() => { const u = [...envPairs]; u[i] = { ...u[i], vis: !u[i].vis }; setEnvPairs(u) }} className="p-1 text-muted hover:text-secondary">
            {p.vis ? <EyeSlash size={12} /> : <Eye size={12} />}
          </button>
          <button onClick={() => setEnvPairs(envPairs.filter((_, j) => j !== i))} className="p-1 text-muted hover:text-red-400">
            <X size={12} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-4">
        <button onClick={() => setEnvPairs([...envPairs, { key: '', value: '', vis: false }])} className="text-[12px] text-muted hover:text-secondary">
          + env var
        </button>
      </div>
      <div className="flex gap-3 pt-1">
        <button onClick={handleAdd} disabled={!name.trim() || !command.trim()} className="text-[12px] text-secondary hover:text-primary disabled:opacity-30">
          Add
        </button>
        <button onClick={onDone} className="text-[12px] text-muted hover:text-secondary">
          Cancel
        </button>
      </div>
    </div>
  )
}

function MCPContent({ rootPath }: { rootPath: string }) {
  const mcpServers = useAIConfigStore((s) => s.mcpServers)
  const load = useAIConfigStore((s) => s.loadMcpServers)
  const [adding, setAdding] = useState(false)
  const [showRegistry, setShowRegistry] = useState(false)

  useEffect(() => { load(rootPath) }, [rootPath, load])

  const servers = Object.values(mcpServers)

  return (
    <div>
      {servers.length === 0 && !adding && !showRegistry && (
        <div className="text-[13px] text-muted py-3 px-1">No MCP servers configured</div>
      )}

      {servers.map((s) => <MCPRow key={s.name} server={s} rootPath={rootPath} />)}

      {adding ? (
        <AddServerForm rootPath={rootPath} onDone={() => setAdding(false)} />
      ) : (
        <div className="flex items-center gap-4 pt-3 px-1">
          <button onClick={() => setAdding(true)} className="text-[12px] text-secondary hover:text-primary transition-colors">
            + Add server
          </button>
          <button onClick={() => setShowRegistry(!showRegistry)} className="text-[12px] text-muted hover:text-secondary transition-colors">
            {showRegistry ? 'Hide registry' : 'Browse registry'}
          </button>
        </div>
      )}

      {showRegistry && <RegistryBrowser rootPath={rootPath} />}
    </div>
  )
}

function RegistryBrowser({ rootPath }: { rootPath: string }) {
  const [q, setQ] = useState('')
  const [envs, setEnvs] = useState<Record<string, string>>({})
  const [installing, setInstalling] = useState<string | null>(null)
  const add = useAIConfigStore((s) => s.addMcpServer)
  const existing = useAIConfigStore((s) => s.mcpServers)
  const results = searchRegistry(q)

  return (
    <div className="pt-3">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search servers..." className={INPUT_CLS} />
      <div className="mt-2 max-h-48 overflow-y-auto">
        {results.map((entry) => {
          const key = entry.name.toLowerCase().replace(/\s+/g, '-')
          const installed = !!existing[key]
          return (
            <div key={entry.name} className="border-b border-subtle py-2 px-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-primary flex-1">{entry.name}</span>
                <span className="text-[11px] text-muted">{entry.category}</span>
                {installed ? (
                  <span className="text-[11px] text-muted">added</span>
                ) : (
                  <button
                    onClick={async () => {
                      setInstalling(entry.name)
                      const env: Record<string, string> = {}
                      entry.requiredEnv.forEach((k) => { env[k] = envs[`${entry.name}:${k}`] || '' })
                      await add({ name: key, command: entry.command, args: entry.args, env }, rootPath)
                      setInstalling(null)
                    }}
                    disabled={installing !== null}
                    className="text-[11px] text-secondary hover:text-primary disabled:opacity-30"
                  >
                    {installing === entry.name ? '...' : 'Add'}
                  </button>
                )}
              </div>
              <div className="text-[11px] text-muted mt-0.5">{entry.description}</div>
              {!installed && entry.requiredEnv.length > 0 && (
                <div className="mt-1.5 space-y-1">
                  {entry.requiredEnv.map((k) => (
                    <input
                      key={k}
                      type="password"
                      value={envs[`${entry.name}:${k}`] || ''}
                      onChange={(e) => setEnvs((prev) => ({ ...prev, [`${entry.name}:${k}`]: e.target.value }))}
                      placeholder={k}
                      className={INPUT_CLS}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// =============================================================================
// Main dialog
// =============================================================================

export function AIConfigDialog({ isOpen, onClose, workspaceId }: AIConfigDialogProps) {
  const [tab, setTab] = useState<Tab>('configs')
  const tools = useAIConfigStore((s) => s.tools)
  const scanning = useAIConfigStore((s) => s.scanning)
  const scan = useAIConfigStore((s) => s.scan)
  const watch = useAIConfigStore((s) => s.watchConfigFiles)

  const rootPath = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath)

  useEffect(() => {
    if (isOpen && rootPath) scan(rootPath)
  }, [isOpen, rootPath]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isOpen || !rootPath) return
    return watch(rootPath)
  }, [isOpen, rootPath, watch])

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler, { capture: true })
    return () => document.removeEventListener('keydown', handler, { capture: true })
  }, [isOpen, onClose])

  if (!isOpen) return null

  const TABS: { id: Tab; label: string }[] = [
    { id: 'configs', label: 'AI Configs' },
    { id: 'skills', label: 'Skills' },
    { id: 'mcp', label: 'MCP Servers' },
  ]

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="w-[540px] h-[480px] bg-surface-5 rounded-lg border border-subtle shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with tabs */}
        <div className="flex items-center justify-between px-5 h-11 shrink-0 border-b border-subtle">
          <div className="flex items-center gap-4">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`text-[13px] transition-colors ${
                  tab === t.id ? 'text-primary' : 'text-muted hover:text-secondary'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {rootPath && (
              <button
                onClick={() => scan(rootPath)}
                disabled={scanning}
                className="p-1.5 text-muted hover:text-secondary disabled:opacity-30"
                title="Refresh"
              >
                <ArrowsClockwise size={13} className={scanning ? 'animate-spin' : ''} />
              </button>
            )}
            <button onClick={onClose} className="p-1.5 text-muted hover:text-secondary">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Content — fixed height, scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {!rootPath ? (
            <NoRootPrompt workspaceId={workspaceId} />
          ) : scanning && !tools ? (
            <div className="flex items-center gap-2 py-6 text-[13px] text-muted">
              <CircleNotch size={14} className="animate-spin" /> Scanning...
            </div>
          ) : (
            <>
              {tab === 'configs' && tools && (
                <ConfigsContent tools={tools} rootPath={rootPath} workspaceId={workspaceId} />
              )}
              {tab === 'skills' && (
                <SkillsContent rootPath={rootPath} workspaceId={workspaceId} />
              )}
              {tab === 'mcp' && <MCPContent rootPath={rootPath} />}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// No root path prompt
// =============================================================================

function NoRootPrompt({ workspaceId }: { workspaceId: string }) {
  const [opening, setOpening] = useState(false)

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <FolderOpen size={28} className="text-muted" />
      <p className="text-[13px] text-muted">Select a project folder first</p>
      <button
        onClick={async () => {
          setOpening(true)
          const p = await window.electronAPI.openFolderDialog()
          if (p) useAppStore.getState().setWorkspaceRootPath(workspaceId, p)
          setOpening(false)
        }}
        disabled={opening}
        className="text-[13px] text-secondary hover:text-primary transition-colors disabled:opacity-30"
      >
        {opening ? 'Opening...' : 'Open Folder'}
      </button>
    </div>
  )
}
