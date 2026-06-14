// =============================================================================
// AgentSettingsView — per-agent settings: the workspace's custom subagents and
// prompt templates (<cwd>/.cate/pi-agent/{agents,prompts}). Reads/writes through
// electronAPI; opening a file routes through openFileAsPanel into a center-dock
// editor tab (visible in the main window or a detached agent window).
//
// Scope: Agents + Prompts only. Skills are managed by the global cross-agent
// Skills installer (sidebar), not here; the extension marketplace was removed in
// favor of Cate's bundled, opinionated extension set. Provider sign-in lives in
// the main Cate Settings (Providers section).
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, FolderOpen, Trash } from '@phosphor-icons/react'
import log from '../../renderer/lib/logger'
import { errorMessage as toErrorMessage } from '../../renderer/lib/errorMessage'
import { openFileAsPanel } from '../../renderer/lib/fs/fileRouting'
import { Tooltip } from '../../renderer/ui/Tooltip'

const TAB_BADGE: Record<'agents' | 'prompts', string> = {
  agents: 'Subagent',
  prompts: 'Prompt',
}

const TAB_BADGE_COLOR: Record<'agents' | 'prompts', string> = {
  agents: 'text-muted bg-hover',
  prompts: 'text-muted bg-hover',
}

export function SettingsView({
  workspaceId,
  cwd,
  onBack,
  onRefresh,
}: {
  workspaceId: string
  cwd: string
  onBack: () => void
  onRefresh: () => void
}) {
  const [activeSection, setActiveSection] = useState('agents')
  const scrollRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({})

  const scrollTo = useCallback((id: string) => {
    const el = sectionRefs.current[id]
    if (el && scrollRef.current) {
      const top = el.offsetTop - scrollRef.current.offsetTop
      scrollRef.current.scrollTo({ top, behavior: 'smooth' })
    }
  }, [])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const handler = () => {
      const ids = ['agents', 'prompts']
      let closest = ids[0]
      let closestDist = Infinity
      for (const id of ids) {
        const el = sectionRefs.current[id]
        if (!el) continue
        const dist = Math.abs(el.offsetTop - container.offsetTop - container.scrollTop)
        if (dist < closestDist) { closestDist = dist; closest = id }
      }
      setActiveSection(closest)
    }
    container.addEventListener('scroll', handler, { passive: true })
    return () => container.removeEventListener('scroll', handler)
  }, [])

  const [agentFiles, setAgentFiles] = useState<Array<{ name: string; description?: string; path: string }>>([])
  const [promptFiles, setPromptFiles] = useState<Array<{ name: string; description?: string; path: string }>>([])
  const [creating, setCreating] = useState<'agents' | 'prompts' | null>(null)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refreshAllFiles = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([
        window.electronAPI.agentListSkillFiles(cwd, 'agents'),
        window.electronAPI.agentListSkillFiles(cwd, 'prompts'),
      ])
      setAgentFiles(a); setPromptFiles(p)
    } catch (err) { log.warn('[SettingsView] list failed', err) }
  }, [cwd])

  useEffect(() => { void refreshAllFiles() }, [refreshAllFiles])

  const handleCreate = async (kind: 'agents' | 'prompts'): Promise<void> => {
    setError(null)
    try {
      const created = await window.electronAPI.agentCreateSkill(cwd, kind, newName)
      setNewName(''); setCreating(null)
      await refreshAllFiles()
      onRefresh()
      openFileAsPanel(workspaceId, created, undefined, { target: 'dock', zone: 'center' })
    } catch (err) {
      setError(toErrorMessage(err))
    }
  }

  const handleOpen = (filePath?: string): void => {
    if (!filePath) return
    // Open as a visible editor tab in the center dock zone (same as the file
    // explorer / search results), rather than dropping an editor node onto the
    // canvas where it may land off-screen or behind the placement picker. Works
    // identically whether the agent panel is in the main window or detached.
    openFileAsPanel(workspaceId, filePath, undefined, { target: 'dock', zone: 'center' })
  }

  const handleDelete = async (kind: string, filePath?: string): Promise<void> => {
    if (!filePath) return
    if (!window.confirm(`Delete this ${kind.slice(0, -1)}?`)) return
    try {
      await window.electronAPI.agentDeleteSkillFile(cwd, filePath)
      await refreshAllFiles()
      onRefresh()
    } catch (err) {
      setError(toErrorMessage(err))
    }
  }

  const sections = ['Agents', 'Prompts'] as const

  const renderSkillSection = (
    kind: 'agents' | 'prompts',
    files: Array<{ name: string; description?: string; path: string }>,
  ) => (
    <>
      <div className="flex items-center gap-2 mt-2">
        {creating !== kind && (
          <button
            onClick={() => { setCreating(kind); setError(null); setNewName('') }}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-agent/20 hover:bg-agent/30 text-primary text-[12px]"
          >
            <Plus size={11} /> New {kind.slice(0, -1)}
          </button>
        )}
        <button
          onClick={() => window.electronAPI.agentOpenSkillsFolder(cwd, kind).catch(() => {})}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-hover hover:bg-hover-strong text-primary text-[12px]"
        >
          <FolderOpen size={11} /> Open folder
        </button>
      </div>
      {creating === kind && (
        <div className="rounded-lg bg-hover p-2 flex items-center gap-2 mt-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate(kind)
              if (e.key === 'Escape') { setCreating(null); setNewName(''); setError(null) }
            }}
            placeholder={`${kind.slice(0, -1)} name`}
            className="flex-1 bg-surface-3 border border-strong rounded-md px-2 py-1 text-[12px] text-primary outline-none focus:border-agent/60 font-mono"
          />
          <button
            onClick={() => handleCreate(kind)}
            disabled={!newName.trim()}
            className="px-2.5 py-1 rounded-md bg-agent hover:bg-agent-light disabled:opacity-40 text-white text-[12px]"
          >
            Create
          </button>
          <button
            onClick={() => { setCreating(null); setNewName(''); setError(null) }}
            className="px-2 py-1 rounded-md text-muted hover:text-primary text-[12px]"
          >
            Cancel
          </button>
        </div>
      )}
      {creating === kind && error && <div className="text-[12px] text-primary mt-1">{error}</div>}
      <div className="rounded-lg bg-hover overflow-hidden mt-2">
        {files.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-muted">
            No {kind} yet.
          </div>
        ) : (
          <>
            {files.map((f) => (
              <SkillRow
                key={f.path}
                name={f.name}
                description={f.description}
                badge={TAB_BADGE[kind]}
                badgeClass={TAB_BADGE_COLOR[kind]}
                filePath={f.path}
                deletable={true}
                onOpen={() => handleOpen(f.path)}
                onDelete={() => handleDelete(kind, f.path)}
              />
            ))}
          </>
        )}
      </div>
    </>
  )

  return (
    <div className="flex-1 flex min-h-0 text-primary">
      <div className="w-[110px] shrink-0 py-4 pl-3 pr-1 flex flex-col gap-0.5">
        <button onClick={onBack} className="text-[11px] text-muted hover:text-primary mb-3 text-left">
          ← Back
        </button>
        {sections.map((label) => {
          const id = label.toLowerCase()
          return (
            <button
              key={id}
              onClick={() => scrollTo(id)}
              className={`text-left px-2 py-1 rounded-md text-[12px] ${
                activeSection === id
                  ? 'text-primary bg-hover-strong'
                  : 'text-muted hover:text-primary'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto py-4 pr-4 pl-2 min-h-0 space-y-8">
        <div ref={(el) => { sectionRefs.current['agents'] = el }}>
          <div className="text-[13px] font-semibold text-primary mb-1">Agents</div>
          {renderSkillSection('agents', agentFiles)}
        </div>

        <div ref={(el) => { sectionRefs.current['prompts'] = el }}>
          <div className="text-[13px] font-semibold text-primary mb-1">Prompts</div>
          {renderSkillSection('prompts', promptFiles)}
        </div>
      </div>
    </div>
  )
}

function SkillRow({
  name,
  description,
  badge,
  badgeClass,
  filePath,
  deletable,
  onOpen,
  onDelete,
}: {
  name: string
  description?: string
  badge: string
  badgeClass: string
  filePath?: string
  deletable: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const clickable = !!filePath
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="group flex items-center gap-2 px-3 py-2 border-b border-subtle last:border-0 hover:bg-hover"
    >
      <button
        onClick={onOpen}
        disabled={!clickable}
        className="flex-1 min-w-0 flex items-start gap-2 text-left disabled:cursor-default"
      >
        <span className={`shrink-0 mt-[1px] px-1.5 py-[1px] rounded text-[9px] uppercase tracking-wider font-semibold ${badgeClass}`}>
          {badge}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] text-primary font-mono">{name}</div>
          {description && (
            <div className="text-[11px] text-muted truncate">{description}</div>
          )}
        </div>
      </button>
      {hovered && deletable && (
        <Tooltip label="Delete">
          <button
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            className="p-1 rounded-md text-muted hover:text-primary hover:bg-hover-strong"
            aria-label="Delete"
          >
            <Trash size={11} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
