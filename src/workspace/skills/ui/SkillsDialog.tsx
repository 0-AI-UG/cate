// The skills view: gives the agents in one workspace a skill.
//
// Sections, all filtered together by the search box:
//   - Cate: Cate's own first-party skills, pinned to the top.
//   - Installed: what's in this workspace now.
//   - Browse: the catalog (curated index, bundled skills and the workspace's
//     sources), shown by default.
//
// Installing only writes to this workspace. Catalog sources live in
// Settings > Skills (gear).

import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ChevronRight, Folder, SlidersHorizontal, LayoutGrid, List, X, Check, ChevronDown as CaretDown, SquareArrowOutUpRight as ArrowSquareOut } from 'lucide-react'
import { Search as MagnifyingGlass, RefreshCw as ArrowsClockwise } from 'lucide-react'
import { useRuntime } from '@kernel/rpc/ui'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { createLogger } from '@kernel/log/contract'
import {
  IconButton,
  InlineNotice,
  LoadingState,
  POPOVER_SURFACE,
  PaletteTextInput,
  Spinner,
  Tooltip,
  clientUi,
  errorMessage,
} from '@kernel/ui'
import type { InstalledSkill, SkillEntry, SkillTarget, SkillTargetId } from '../contract'

const log = createLogger('skills')

// The list of repos the curated catalog is crawled from. Linked in the header so
// anyone can PR a missing skill's source repo in (the CI crawler turns this into
// skills-index.json).
const SKILL_SOURCES_URL = 'https://github.com/0-AI-UG/cate/blob/main/registry/sources.json'

function matches(entry: SkillEntry, terms: string[]): boolean {
  if (terms.length === 0) return true
  const hay = `${entry.name} ${entry.description} ${entry.source.repo}`.toLowerCase()
  return terms.every((t) => hay.includes(t))
}

// GitHub URL for a skill's source folder, or null for stubs with no source
// (e.g. a locally installed skill we know nothing else about).
function sourceUrl(entry: SkillEntry): string | null {
  const { repo, ref, path } = entry.source
  if (!repo) return null
  const branch = ref || 'main'
  return path
    ? `https://github.com/${repo}/tree/${branch}/${path}`
    : `https://github.com/${repo}/tree/${branch}`
}

function stubEntry(m: InstalledSkill): SkillEntry {
  return {
    id: m.skillId,
    name: m.name,
    description: '',
    tags: [],
    format: 'skill-md',
    source: { repo: '', ref: '', path: '' },
    provenance: 'user',
    sourceId: '',
  }
}

export interface SkillsDialogProps {
  /** The workspace to install into; null when no folder is open. */
  workspaceId: string | null
  onClose: () => void
  /** Where the host shows the view (its main content area). Without one the
   *  view covers the window and shows a Back button. */
  container?: HTMLElement | null
  /** The host's overlay header chrome; gets the header actions. */
  renderHeader?: (actions: ReactNode) => ReactNode
}

function DefaultHeader({ children }: { children: ReactNode }) {
  return (
    <header className="relative z-10 flex h-11 shrink-0 items-center gap-2 bg-canvas-bg px-6 text-primary after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-gradient-to-b after:from-canvas-bg after:to-transparent">
      <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium">Skills</h1>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </header>
  )
}

export function SkillsDialog({ workspaceId, onClose, container, renderHeader }: SkillsDialogProps) {
  const runtime = useRuntime(workspaceId)
  const skills = runtime?.skills ?? null
  const [index, setIndex] = useState<SkillEntry[]>([])
  const [targets, setTargets] = useState<SkillTarget[]>([])
  const [installed, setInstalled] = useState<InstalledSkill[]>([])
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useState<'list' | 'card'>('list')
  const [browseMode, setBrowseMode] = useState<'skills' | 'repositories'>('skills')
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refreshInstalled = useCallback(async () => {
    if (!skills) return setInstalled([])
    try {
      setInstalled(await skills.listInstalled())
    } catch (err) {
      log.warn('listInstalled failed: %s', err)
    }
  }, [skills])

  const loadIndex = useCallback(async (refresh = false) => {
    if (!skills) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setIndex(await skills.index({ refresh }))
    } catch (err) {
      log.warn('index failed: %s', err)
    } finally {
      setLoading(false)
    }
  }, [skills])

  useEffect(() => {
    setError(null)
    void loadIndex()
    void refreshInstalled()
    if (skills) skills.targets().then(setTargets, (err) => log.warn('targets failed: %s', err))
    else setTargets([])
  }, [skills, loadIndex, refreshInstalled])

  // Escape closes, in the capture phase so the view wins over nested handlers.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    document.addEventListener('keydown', handler, { capture: true })
    return () => document.removeEventListener('keydown', handler, { capture: true })
  }, [onClose])

  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query])
  const installedKeys = useMemo(
    () => new Set(installed.map((m) => `${m.skillId}:${m.targetId}`)),
    [installed],
  )
  const installedIds = useMemo(() => new Set(installed.map((m) => m.skillId)), [installed])

  // One metadata source per skill: the catalog, else a manifest stub for
  // anything installed we know nothing else about.
  const byId = useMemo(() => {
    const m = new Map<string, SkillEntry>()
    for (const e of index) if (!m.has(e.id)) m.set(e.id, e)
    for (const inst of installed) if (!m.has(inst.skillId)) m.set(inst.skillId, stubEntry(inst))
    return m
  }, [index, installed])

  const installedRows = useMemo(
    () =>
      [...installedIds]
        .map((id) => byId.get(id))
        .filter((e): e is SkillEntry => !!e && matches(e, terms))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [installedIds, byId, terms],
  )
  // Catalog entries not already installed, matching the query, split into
  // Cate's own (pinned to the top) and the rest (Browse), so each shows once.
  const available = useCallback(
    (e: SkillEntry) => !installedIds.has(e.id) && matches(e, terms),
    [installedIds, terms],
  )
  const cateRows = useMemo(
    () =>
      index
        .filter((e) => e.firstParty && available(e))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [index, available],
  )
  const browseRows = useMemo(
    () =>
      index
        .filter((e) => !e.firstParty && available(e))
        .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || a.name.localeCompare(b.name)),
    [index, available],
  )
  const repositories = useMemo(() => {
    const groups = new Map<string, { repo: string; entries: SkillEntry[] }>()
    for (const entry of browseRows) {
      const key = entry.source.repo.toLowerCase()
      const group = groups.get(key)
      if (group) group.entries.push(entry)
      else groups.set(key, { repo: entry.source.repo, entries: [entry] })
    }
    return [...groups.values()]
  }, [browseRows])
  const visibleBrowseRows = browseMode === 'repositories' && selectedRepo !== null
    ? browseRows.filter((entry) => entry.source.repo.toLowerCase() === selectedRepo.toLowerCase())
    : browseRows

  const empty = cateRows.length === 0 && installedRows.length === 0 && browseRows.length === 0

  // Key on id + path, not id alone: a repo can expose the same skill name at
  // two paths, which collide to one id, and duplicate keys leave stale rows
  // mounted when the query filters the list.
  const renderRow = (entry: SkillEntry, installedRow: boolean) => (
    <SkillRow
      key={`${entry.id}#${entry.source.path}`}
      entry={entry}
      viewMode={viewMode}
      installed={installedRow}
      skills={skills}
      targets={targets}
      installedKeys={installedKeys}
      onChanged={() => void refreshInstalled()}
      onError={setError}
    />
  )

  const itemsClassName = viewMode === 'card'
    ? 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-3'
    : 'flex flex-col gap-1'

  const headerActions = (
    <>
      {!container && <button type="button" onClick={onClose} className="text-sm text-muted hover:text-primary">Back</button>}
      <button
        type="button"
        onClick={() => clientUi().openExternal(SKILL_SOURCES_URL)}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary"
        title="Suggest a missing skill for the catalog"
      >
        Add a skill source
        <ArrowSquareOut size={13} />
      </button>
    </>
  )

  return createPortal(
    <section aria-label="Skills" className={`${container ? 'h-full w-full' : 'fixed inset-0 z-[100001]'} pointer-events-auto flex min-h-0 flex-col bg-canvas-bg text-primary`}>
      {renderHeader ? renderHeader(headerActions) : <DefaultHeader>{headerActions}</DefaultHeader>}
      <div className="mx-auto flex w-full max-w-[1040px] min-h-0 flex-1 flex-col px-6">
        <div className="py-4 shrink-0 flex items-center gap-2">
          <PaletteTextInput
              icon={<MagnifyingGlass size={14} />}
              containerClassName="flex-1"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }}
              placeholder="Search skills…"
              spellCheck={false}
          />
          <IconBtn
            title={viewMode === 'list' ? 'Card view' : 'List view'}
            onClick={() => setViewMode((mode) => mode === 'list' ? 'card' : 'list')}
          >
            {viewMode === 'list' ? <LayoutGrid size={15} /> : <List size={15} />}
          </IconBtn>
          <IconBtn title="Refresh catalog" onClick={() => void loadIndex(true)}>
            {loading ? <Spinner size={15} /> : <ArrowsClockwise size={15} />}
          </IconBtn>
          <IconBtn title="Skill sources & settings" onClick={() => { onClose(); clientUi().openSettings('skills') }}>
            <SlidersHorizontal size={15} />
          </IconBtn>
        </div>

        {error && (
          <InlineNotice tone="error" className="mx-2 mb-1.5 flex items-start gap-2 border-0">
            <span className="flex-1 whitespace-pre-wrap break-words">{error}</span>
            <button type="button" aria-label="Dismiss error" onClick={() => setError(null)} className="text-muted hover:text-primary"><X size={12} /></button>
          </InlineNotice>
        )}

        <div
          className="flex-1 min-h-0 overflow-y-auto pt-4 pb-6"
          style={{ maskImage: 'linear-gradient(to bottom, transparent, black 16px)' }}
        >
          {cateRows.length > 0 && (
            <>
              <GroupLabel>Cate · {cateRows.length}</GroupLabel>
              <div className={itemsClassName}>{cateRows.map((e) => renderRow(e, false))}</div>
            </>
          )}

          {installedRows.length > 0 && (
            <>
              <GroupLabel>Installed · {installedRows.length}</GroupLabel>
              <div className={itemsClassName}>{installedRows.map((e) => renderRow(e, true))}</div>
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-5 pb-3 px-3">
            <h2 className="text-sm font-medium text-secondary">Browse · {browseMode === 'repositories' && selectedRepo === null ? repositories.length : visibleBrowseRows.length}</h2>
            <div role="group" aria-label="Browse by" className="flex rounded-lg bg-surface-1 p-0.5 text-xs">
              {(['skills', 'repositories'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={browseMode === mode}
                  onClick={() => { setBrowseMode(mode); setSelectedRepo(null) }}
                  className={`rounded-md px-3 py-1.5 ${browseMode === mode ? 'bg-surface-3 text-primary' : 'text-muted hover:text-primary'}`}
                >
                  {mode === 'skills' ? 'All skills' : 'Repositories'}
                </button>
              ))}
            </div>
          </div>
          {browseMode === 'repositories' && selectedRepo !== null && (
            <div className="flex items-center gap-3 px-3 pb-3 text-xs">
              <button type="button" onClick={() => setSelectedRepo(null)} className="flex shrink-0 items-center gap-1 text-muted hover:text-primary">
                <ArrowLeft size={14} /> All repositories
              </button>
              <span className="truncate text-primary">{selectedRepo || 'Unknown repository'}</span>
            </div>
          )}
          {loading && browseRows.length === 0 ? (
            <LoadingState label="Loading skills…" size={15} className="px-4 py-6 text-[13px]" />
          ) : browseMode === 'repositories' && selectedRepo !== null && visibleBrowseRows.length === 0 ? (
            <div className="px-4 py-6 text-center text-[13px] text-muted">No available skills match in this repository.</div>
          ) : browseRows.length === 0 ? (
            <div className="px-4 py-6 text-center text-[13px] text-muted">
              {!skills
                ? 'Open a folder to browse skills.'
                : index.length === 0
                  ? 'No catalog yet. Add a repo in Settings → Skills.'
                  : empty
                    ? 'No matches.'
                    : terms.length
                      ? 'No other catalog matches.'
                      : 'Everything in the catalog is already here.'}
            </div>
          ) : browseMode === 'repositories' && selectedRepo === null ? (
            <div className={itemsClassName}>
              {repositories.map(({ repo, entries }) => (
                <button
                  key={repo.toLowerCase()}
                  type="button"
                  aria-label={`Browse ${repo || 'Unknown repository'}`}
                  onClick={() => setSelectedRepo(repo)}
                  className={`flex min-w-0 items-center gap-3 rounded-xl text-left transition-colors ${viewMode === 'card' ? 'border border-subtle bg-surface-1 p-4 hover:bg-surface-2' : 'px-3 py-3 hover:bg-surface-1'}`}
                >
                  <Folder size={18} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-primary">{repo || 'Unknown repository'}</span>
                    <span className="mt-1 block text-xs text-muted">{entries.length} {terms.length ? 'matching ' : ''}{entries.length === 1 ? 'skill' : 'skills'}</span>
                  </span>
                  <ChevronRight size={15} className="shrink-0 text-muted" />
                </button>
              ))}
            </div>
          ) : (
            <div className={itemsClassName}>{visibleBrowseRows.map((e) => renderRow(e, false))}</div>
          )}
        </div>
      </div>
    </section>,
    container ?? document.body,
  )
}

type SkillsApi = RuntimeProxy['skills']

// One skill row: the name, and Install (a per-agent menu for this workspace).
function SkillRow({
  entry,
  viewMode,
  installed,
  skills,
  targets,
  installedKeys,
  onChanged,
  onError,
}: {
  entry: SkillEntry
  viewMode: 'list' | 'card'
  installed: boolean
  skills: SkillsApi | null
  targets: SkillTarget[]
  installedKeys: Set<string>
  onChanged: () => void
  onError: (m: string | null) => void
}) {
  const installRef = useRef<HTMLButtonElement>(null)
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; left: number } | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const link = sourceUrl(entry)

  const openMenu = () => {
    const r = installRef.current?.getBoundingClientRect()
    if (r) setMenuAnchor({ top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 208) })
  }

  const updateInstalled = async () => {
    const installedTargets = targets.filter((target) => installedKeys.has(`${entry.id}:${target.id}`))
    if (!skills || installedTargets.length === 0) return
    onError(null)
    setUpdateBusy(true)
    try {
      const results = await Promise.allSettled(
        installedTargets.map((target) => skills.install({ entry, targetId: target.id })),
      )
      const errors = results.flatMap((result) =>
        result.status === 'fulfilled'
          ? result.value.warnings
          : [errorMessage(result.reason, 'Could not update skill.')],
      )
      if (errors.length) onError(errors.join('\n'))
      onChanged()
    } finally {
      setUpdateBusy(false)
    }
  }

  return (
    <article className={`group min-w-0 rounded-xl transition-colors ${viewMode === 'card'
      ? 'flex flex-col gap-3 border border-subtle bg-surface-1 p-4 hover:bg-surface-2'
      : 'flex items-start gap-3 px-3 py-3 hover:bg-surface-1'}`}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-medium text-primary truncate">{entry.name}</span>
          {typeof entry.stars === 'number' && entry.stars > 0 && (
            <span className="shrink-0 text-[10px] text-muted tabular-nums">
              {entry.stars > 999 ? `${Math.round(entry.stars / 1000)}k` : entry.stars}★
            </span>
          )}
        </div>
        {entry.description && <p className={`mt-1 text-xs leading-relaxed text-muted ${viewMode === 'card' ? 'line-clamp-3' : 'line-clamp-2'}`}>{entry.description}</p>}
        {entry.source.repo && <div className="mt-2 truncate text-[11px] text-muted" title={entry.source.repo}>{entry.source.repo}</div>}
      </div>
      </div>

      <div className={`flex shrink-0 items-center gap-1.5 ${viewMode === 'card' ? 'justify-end border-t border-subtle pt-3' : 'pt-0.5'}`}>
      {installed && link && (
        <Tooltip label="Update installed copies from source">
          <button
            onClick={() => void updateInstalled()}
            disabled={updateBusy}
            aria-label="Update installed copies from source"
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded-lg text-muted hover:text-secondary disabled:opacity-50"
          >
            {updateBusy ? <Spinner size={14} /> : <ArrowsClockwise size={14} />}
          </button>
        </Tooltip>
      )}

      {link && (
        <Tooltip label="Open skill on GitHub">
          <button
            onClick={() => clientUi().openExternal(link)}
            aria-label="Open skill on GitHub"
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded-lg text-muted hover:text-secondary"
          >
            <ArrowSquareOut size={14} />
          </button>
        </Tooltip>
      )}

      <button
        ref={installRef}
        onClick={openMenu}
        disabled={!skills}
        className={`shrink-0 flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 disabled:opacity-40 ${
          installed ? 'text-secondary hover:text-primary' : 'text-primary'
        }`}
        title={skills ? 'Install for an agent in this workspace' : 'Open a folder first'}
      >
        {installed ? 'Agents' : 'Install'}
        <CaretDown size={10} className="opacity-60" />
      </button>
      </div>

      {menuAnchor && skills && (
        <AgentMenu
          entry={entry}
          anchor={menuAnchor}
          triggerRef={installRef}
          skills={skills}
          targets={targets}
          installedKeys={installedKeys}
          onChanged={onChanged}
          onError={onError}
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </article>
  )
}

// The agents of this workspace in one popover column. Clicking toggles
// install/uninstall; a check marks installed agents.
function AgentMenu({
  entry,
  anchor,
  triggerRef,
  skills,
  targets,
  installedKeys,
  onChanged,
  onError,
  onClose,
}: {
  entry: SkillEntry
  anchor: { top: number; left: number }
  triggerRef: React.RefObject<HTMLButtonElement>
  skills: SkillsApi
  targets: SkillTarget[]
  installedKeys: Set<string>
  onChanged: () => void
  onError: (m: string | null) => void
  onClose: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState<SkillTargetId | null>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (rootRef.current?.contains(t)) return
      if (triggerRef.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose, triggerRef])

  const toggle = async (targetId: SkillTargetId) => {
    const on = installedKeys.has(`${entry.id}:${targetId}`)
    onError(null)
    setBusy(targetId)
    try {
      const { warnings } = on
        ? await skills.uninstall({ skillId: entry.id, targetId })
        : await skills.install({ entry, targetId })
      if (warnings.length) onError(warnings.join('\n'))
      onChanged()
    } catch (err) {
      onError(errorMessage(err, on ? 'Could not remove skill.' : 'Could not install skill.'))
    } finally {
      setBusy(null)
    }
  }

  return createPortal(
    <div
      ref={rootRef}
      className={`fixed z-[1000] w-[200px] ${POPOVER_SURFACE} p-1.5 text-xs`}
      style={{ top: anchor.top, left: anchor.left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-2.5 pt-0.5 pb-1 text-[11px] font-medium text-muted select-none">Install for</div>
      {targets.map((t) => {
        const on = installedKeys.has(`${entry.id}:${t.id}`)
        const working = busy === t.id
        return (
          <button
            key={t.id}
            onClick={() => void toggle(t.id)}
            disabled={working}
            className="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-primary hover:bg-hover focus-visible:bg-hover disabled:opacity-50"
            title={on ? 'Uninstall skill' : 'Install skill'}
          >
            <span className="w-3.5 shrink-0 flex items-center justify-center text-accent">
              {working ? <Spinner size={11} /> : on ? <Check size={11} /> : null}
            </span>
            <span className="flex-1">{t.label}</span>
            {t.beta && <span className="text-[8px] uppercase opacity-60">beta</span>}
          </button>
        )
      })}
    </div>,
    document.body,
  )
}

function IconBtn({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode
  title: string
  onClick: () => void
}) {
  return (
      <IconButton
        label={title}
        size={28}
        onClick={onClick}
        className="rounded-[10px] text-muted hover:bg-white/5"
      >
        {children}
      </IconButton>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="px-3 pt-5 pb-3 text-sm font-medium text-secondary">{children}</h2>
}
