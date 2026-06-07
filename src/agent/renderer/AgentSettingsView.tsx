// =============================================================================
// AgentSettingsView — the settings surface that replaces the chat column:
// the user's agents/prompts/skills files, and the extension marketplace.
// Reads/writes through electronAPI; opening a file routes to a new editor panel
// via appStore. Provider sign-in lives in the main Cate Settings (Providers
// section), not here.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, FolderOpen, ArrowsClockwise, Trash } from '@phosphor-icons/react'
import log from '../../renderer/lib/logger'
import { useAppStore } from '../../renderer/stores/appStore'
import type { AgentSlashCommand } from '../../shared/types'

// Skills moved to the dedicated cross-agent Skills sidebar view; this settings
// surface keeps the per-agent Agents/Prompts/Extensions only.
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
  /** Still accepted from AgentPanel; skills (the only consumer) moved out. */
  commands?: AgentSlashCommand[]
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
      const ids = ['agents', 'prompts', 'extensions']
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
      useAppStore.getState().createEditor(workspaceId, created)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleOpen = (filePath?: string): void => {
    if (!filePath) return
    useAppStore.getState().createEditor(workspaceId, filePath)
  }

  const handleDelete = async (kind: string, filePath?: string): Promise<void> => {
    if (!filePath) return
    if (!window.confirm(`Delete this ${kind.slice(0, -1)}?`)) return
    try {
      await window.electronAPI.agentDeleteSkillFile(cwd, filePath)
      await refreshAllFiles()
      onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const [refreshNonce, setRefreshNonce] = useState(0)

  const sections = ['Agents', 'Prompts', 'Extensions'] as const

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

        <div ref={(el) => { sectionRefs.current['extensions'] = el }}>
          <div className="flex items-center justify-between mb-3">
            <div className="text-[13px] font-semibold text-primary">Extensions</div>
            <button
              onClick={() => setRefreshNonce((n) => n + 1)}
              className="p-1 rounded-md text-muted hover:text-primary hover:bg-hover"
              title="Refresh"
            >
              <ArrowsClockwise size={12} />
            </button>
          </div>
          <ExtensionsTab cwd={cwd} refreshNonce={refreshNonce} />
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Extensions tab — Pi extension marketplace (install/uninstall pi packages)
// -----------------------------------------------------------------------------

interface MarketplaceCatalogEntry {
  name: string
  description: string
  author: string
  downloads: number
  type: string
  repoUrl: string
  requiresTerminal: boolean
}

interface InstalledExtensionEntry {
  name: string
  description?: string
  requiresTerminal: boolean
  path: string
}

const TERMINAL_TOOLTIP =
  'Some features in this extension require a terminal and are not supported in Cate yet.'

type MarketplaceSortValue = 'downloads' | 'recent' | 'name'

function ExtensionsTab({ cwd, refreshNonce = 0 }: { cwd: string; refreshNonce?: number }) {
  const [catalog, setCatalog] = useState<MarketplaceCatalogEntry[]>([])
  const [installed, setInstalled] = useState<InstalledExtensionEntry[]>([])
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<MarketplaceSortValue>('downloads')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [pending, setPending] = useState<Record<string, 'install' | 'uninstall' | undefined>>({})
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [browseLoading, setBrowseLoading] = useState(false)

  const refreshInstalled = useCallback(async () => {
    try {
      const list = await window.electronAPI.agentMarketplaceListInstalled(cwd)
      setInstalled(list)
    } catch (err) {
      log.warn('[ExtensionsTab] listInstalled failed', err)
    }
  }, [cwd])

  // Debounce the search input: typing waits 300ms before triggering a fetch.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setQuery(queryInput.trim())
      setPage(1)
    }, 300)
    return () => { window.clearTimeout(handle) }
  }, [queryInput])

  // Initial installed list — independent of marketplace fetch. Re-runs when
  // the parent bumps `refreshNonce` (top-bar Refresh button).
  useEffect(() => { void refreshInstalled() }, [refreshInstalled, refreshNonce])

  // Marketplace fetch — re-runs on page/query/sort change, and on parent
  // refresh-nonce bumps from the top-bar Refresh button.
  useEffect(() => {
    let cancelled = false
    setBrowseLoading(true)
    void (async () => {
      try {
        const res = await window.electronAPI.agentMarketplaceList({ page, query, sort })
        if (cancelled) return
        setCatalog(res.entries)
        setTotalPages(res.totalPages)
      } catch (err) {
        if (!cancelled) {
          log.warn('[ExtensionsTab] marketplaceList failed', err)
          setCatalog([])
        }
      } finally {
        if (!cancelled) {
          setBrowseLoading(false)
          setLoaded(true)
        }
      }
    })()
    return () => { cancelled = true }
  }, [page, query, sort, refreshNonce])

  const installedNames = useMemo(
    () => new Set(installed.map((e) => e.name)),
    [installed],
  )

  // Backend handles search/sort/pagination — the renderer just renders.
  const filtered = catalog

  const setRowPending = (name: string, kind: 'install' | 'uninstall' | undefined): void => {
    setPending((prev) => {
      const next = { ...prev }
      if (kind) next[name] = kind
      else delete next[name]
      return next
    })
  }

  const handleInstall = async (name: string): Promise<void> => {
    setError(null)
    setRowPending(name, 'install')
    try {
      const res = await window.electronAPI.agentMarketplaceInstall(cwd, name)
      if (!res.ok) {
        setError(res.error ?? `Failed to install ${name}`)
      }
      await refreshInstalled()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRowPending(name, undefined)
    }
  }

  const handleUninstall = async (name: string): Promise<void> => {
    if (!window.confirm(`Uninstall ${name}?`)) return
    setError(null)
    setRowPending(name, 'uninstall')
    try {
      const res = await window.electronAPI.agentMarketplaceUninstall(cwd, name)
      if (!res.ok) {
        setError(res.error ?? `Failed to uninstall ${name}`)
      }
      await refreshInstalled()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRowPending(name, undefined)
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-danger bg-danger-tint px-3 py-2 text-[12px] text-primary whitespace-pre-wrap break-words">
          {error}
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[11px] uppercase tracking-wider text-muted">Installed</div>
        </div>
        <div className="rounded-lg bg-hover overflow-hidden">
          {installed.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-muted">
              No extensions installed.
            </div>
          ) : (
            installed.map((e) => (
              <ExtensionRow
                key={e.path}
                name={e.name}
                description={e.description}
                requiresTerminal={e.requiresTerminal}
                actionLabel="Uninstall"
                actionTone="danger"
                disabled={pending[e.name] !== undefined}
                busy={pending[e.name] === 'uninstall'}
                onAction={() => { void handleUninstall(e.name) }}
              />
            ))
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5 gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted">
            <span>Browse marketplace</span>
            {browseLoading && (
              <span
                aria-label="Loading"
                className="inline-block h-2.5 w-2.5 rounded-full border border-agent-light/40 border-t-agent-light animate-spin"
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as MarketplaceSortValue)
                setPage(1)
              }}
              className="bg-surface-3 border border-strong rounded-md px-2 py-1 text-[12px] text-primary outline-none focus:border-agent/60"
            >
              <option value="downloads">Most downloads</option>
              <option value="recent">Recently published</option>
              <option value="name">A-Z</option>
            </select>
            <input
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              placeholder="Search..."
              className="bg-surface-3 border border-strong rounded-md px-2 py-1 text-[12px] text-primary outline-none focus:border-agent/60 w-[180px]"
            />
          </div>
        </div>
        <div className="rounded-lg bg-hover overflow-hidden">
          {!loaded ? (
            <div className="px-3 py-6 text-center text-[12px] text-muted">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-muted">
              {catalog.length === 0 ? 'Catalog unavailable.' : 'No matching extensions.'}
            </div>
          ) : (
            filtered.map((e) => {
              const isInstalled = installedNames.has(e.name)
              const busy = pending[e.name] === 'install'
              return (
                <ExtensionRow
                  key={e.name}
                  name={e.name}
                  description={e.description}
                  author={e.author}
                  downloads={e.downloads}
                  requiresTerminal={e.requiresTerminal}
                  actionLabel={isInstalled ? 'Installed' : 'Install'}
                  actionTone={isInstalled ? 'muted' : 'primary'}
                  disabled={isInstalled || pending[e.name] !== undefined}
                  busy={busy}
                  onAction={() => { if (!isInstalled) void handleInstall(e.name) }}
                />
              )
            })
          )}
        </div>
        {totalPages > 1 && (
          <div className="mt-2 flex items-center justify-center gap-3 text-[11px] text-muted">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={browseLoading || page <= 1}
              className="px-2 py-1 rounded-md bg-hover hover:bg-agent/20 hover:text-primary disabled:opacity-40 disabled:cursor-default disabled:hover:bg-[var(--surface-hover)] disabled:hover:text-muted"
            >
              « Prev
            </button>
            <span>
              Page <span className="text-primary">{page}</span> of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={browseLoading || page >= totalPages}
              className="px-2 py-1 rounded-md bg-hover hover:bg-agent/20 hover:text-primary disabled:opacity-40 disabled:cursor-default disabled:hover:bg-[var(--surface-hover)] disabled:hover:text-muted"
            >
              Next »
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ExtensionRow({
  name,
  description,
  author,
  downloads,
  requiresTerminal,
  actionLabel,
  actionTone,
  disabled,
  busy,
  onAction,
}: {
  name: string
  description?: string
  author?: string
  downloads?: number
  requiresTerminal: boolean
  actionLabel: string
  actionTone: 'primary' | 'danger' | 'muted'
  disabled: boolean
  busy: boolean
  onAction: () => void
}) {
  const toneClass =
    actionTone === 'primary'
      ? 'bg-agent hover:bg-agent-light text-white'
      : actionTone === 'danger'
      ? 'bg-hover hover:bg-danger-tint text-danger'
      : 'bg-hover text-muted'
  return (
    <div className="flex items-start gap-2 px-3 py-2 border-b border-subtle last:border-0 hover:bg-hover">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12.5px] text-primary font-mono truncate">{name}</span>
          {requiresTerminal && (
            <span
              title={TERMINAL_TOOLTIP}
              className="shrink-0 px-1.5 py-[1px] rounded text-[9px] uppercase tracking-wider font-semibold text-agent-light bg-agent/15"
            >
              Terminal required
            </span>
          )}
        </div>
        {description && (
          <div className="text-[11px] text-muted truncate">{description}</div>
        )}
        {(author || (typeof downloads === 'number' && downloads > 0)) && (
          <div className="text-[10.5px] text-muted/80 mt-0.5">
            {author && <span>{author}</span>}
            {author && typeof downloads === 'number' && downloads > 0 ? <span> · </span> : null}
            {typeof downloads === 'number' && downloads > 0 ? <span>{downloads.toLocaleString()} downloads/mo</span> : null}
          </div>
        )}
      </div>
      <button
        onClick={onAction}
        disabled={disabled}
        className={`shrink-0 px-2.5 py-1 rounded-md text-[11px] disabled:opacity-50 disabled:cursor-default flex items-center gap-1.5 ${toneClass}`}
      >
        {busy && (
          <span className="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
        )}
        {busy ? (actionLabel === 'Uninstall' ? 'Removing…' : 'Installing…') : actionLabel}
      </button>
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
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="p-1 rounded-md text-muted hover:text-primary hover:bg-hover-strong"
          title="Delete"
        >
          <Trash size={11} />
        </button>
      )}
    </div>
  )
}
