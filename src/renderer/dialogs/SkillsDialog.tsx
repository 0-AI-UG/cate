// =============================================================================
// SkillsDialog — the skill browser, opened from the left-rail puzzle button.
//
// A modal (Cmd+K-family chrome) for giving the agents in the CURRENT workspace a
// skill. Two independent things you can do to a skill:
//   • Install — write it into this workspace (per agent). Plain installs are not
//     cached; uninstalling forgets them.
//   • Save    — bookmark it to your library (cached in userData) so it's one
//     click away in any workspace, even offline.
//
// Sections, all filtered together by the search box:
//   • Installed — what's in this workspace now.
//   • Saved     — your library, ready to re-add here.
//   • Browse    — the catalog (curated index ∪ user repos), shown by default.
//
// Installing only ever writes to the current workspace — no cross-workspace
// install. Catalog SOURCES (repos / token) live in Settings → Skills (gear).
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  MagnifyingGlass,
  ArrowsClockwise,
  SlidersHorizontal,
  X,
  BookmarkSimple,
  Check,
  CircleNotch,
  CaretDown,
  ArrowSquareOut,
} from '@phosphor-icons/react'
import { BACKDROP, CARD_SURFACE } from '../ui/Modal'
import { useUIStore } from '../stores/uiStore'
import { useAppStore } from '../stores/appStore'
import log from '../lib/logger'
import { errorMessage } from '../lib/errorMessage'
import {
  SKILL_TARGETS,
  type InstalledSkill,
  type SavedSkill,
  type SkillEntry,
  type SkillTargetId,
} from '../../shared/skills'

const api = () => window.electronAPI

function matches(entry: SkillEntry, terms: string[]): boolean {
  if (terms.length === 0) return true
  const hay = `${entry.name} ${entry.description}`.toLowerCase()
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

function savedToEntry(s: SavedSkill): SkillEntry {
  return {
    id: s.skillId,
    name: s.name,
    description: s.description,
    tags: [],
    format: 'skill-md',
    source: s.source,
    stars: s.stars,
    provenance: 'user',
    sourceId: '',
  }
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

export function SkillsDialog() {
  const show = useUIStore((s) => s.showSkillsDialog)
  const setShow = useUIStore((s) => s.setShowSkillsDialog)
  const workspaces = useAppStore((s) => s.workspaces)
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const currentWs = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId),
    [workspaces, selectedWorkspaceId],
  )
  const rootPath = currentWs?.rootPath ?? ''

  const [index, setIndex] = useState<SkillEntry[]>([])
  const [saved, setSaved] = useState<SavedSkill[]>([])
  const [installed, setInstalled] = useState<InstalledSkill[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refreshSaved = useCallback(async () => {
    try {
      setSaved(await api().skillsListSaved())
    } catch (err) {
      log.warn('[SkillsDialog] listSaved failed', err)
    }
  }, [])

  const refreshInstalled = useCallback(async () => {
    if (!rootPath) return setInstalled([])
    try {
      setInstalled(await api().skillsListInstalled(rootPath))
    } catch (err) {
      log.warn('[SkillsDialog] listInstalled failed', err)
    }
  }, [rootPath])

  const loadIndex = useCallback(async (refresh = false) => {
    setLoading(true)
    try {
      setIndex(refresh ? await api().skillsRefresh() : await api().skillsGetIndex())
    } catch (err) {
      log.warn('[SkillsDialog] getIndex failed', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!show) return
    setError(null)
    void loadIndex()
    void refreshSaved()
    void refreshInstalled()
  }, [show, loadIndex, refreshSaved, refreshInstalled])

  const onChanged = useCallback(() => {
    void refreshSaved()
    void refreshInstalled()
  }, [refreshSaved, refreshInstalled])

  const close = useCallback(() => setShow(false), [setShow])

  useEffect(() => {
    if (!show) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close() }
    }
    document.addEventListener('keydown', handler, { capture: true })
    return () => document.removeEventListener('keydown', handler, { capture: true })
  }, [show, close])

  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query])
  const installedKeys = useMemo(
    () => new Set(installed.map((m) => `${m.skillId}:${m.targetId}`)),
    [installed],
  )
  const installedIds = useMemo(() => new Set(installed.map((m) => m.skillId)), [installed])
  const savedIds = useMemo(() => new Set(saved.map((s) => s.skillId)), [saved])

  // One metadata source of truth per skill: saved (best — has source) → catalog
  // → a manifest stub for anything installed we know nothing else about.
  const byId = useMemo(() => {
    const m = new Map<string, SkillEntry>()
    for (const s of saved) m.set(s.skillId, savedToEntry(s))
    for (const e of index) if (!m.has(e.id)) m.set(e.id, e)
    for (const inst of installed) if (!m.has(inst.skillId)) m.set(inst.skillId, stubEntry(inst))
    return m
  }, [saved, index, installed])

  const installedRows = useMemo(
    () =>
      [...installedIds]
        .map((id) => byId.get(id))
        .filter((e): e is SkillEntry => !!e && matches(e, terms))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [installedIds, byId, terms],
  )
  const savedRows = useMemo(
    () =>
      saved
        .filter((s) => !installedIds.has(s.skillId))
        .map((s) => byId.get(s.skillId)!)
        .filter((e) => matches(e, terms))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [saved, installedIds, byId, terms],
  )
  const browseRows = useMemo(
    () =>
      index
        .filter((e) => !savedIds.has(e.id) && !installedIds.has(e.id) && matches(e, terms))
        .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || a.name.localeCompare(b.name)),
    [index, savedIds, installedIds, terms],
  )

  if (!show) return null

  const empty = installedRows.length === 0 && savedRows.length === 0 && browseRows.length === 0

  // Key on id + path, not id alone: a repo can expose the same skill name at two
  // paths, which collide to one id. Duplicate React keys break list diffing, so
  // stale rows stay mounted when the query filters the list down — making search
  // look like it ignores the query. id + path uniquely locates a SKILL.md.
  const renderRow = (entry: SkillEntry, installedRow: boolean) => (
    <SkillRow
      key={`${entry.id}#${entry.source.path}`}
      entry={entry}
      installed={installedRow}
      saved={savedIds.has(entry.id)}
      rootPath={rootPath}
      installedKeys={installedKeys}
      onChanged={onChanged}
      onError={setError}
    />
  )

  return (
    <div className={`fixed inset-0 flex justify-center z-50 ${BACKDROP}`} onClick={close}>
      <div
        className={`w-[600px] max-w-[600px] max-h-[560px] mt-[80px] overflow-hidden flex flex-col self-start ${CARD_SURFACE}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search + actions — no header bar, matching the other dialogs */}
        <div className="p-2 shrink-0 flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2 px-2.5 h-8 rounded-md bg-surface-0/60 border border-strong focus-within:border-[rgba(255,255,255,0.18)] transition-colors">
            <MagnifyingGlass size={14} className="text-muted shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }}
              placeholder="Search skills…"
              spellCheck={false}
              className="flex-1 bg-transparent text-primary text-[13px] outline-none placeholder:text-muted"
            />
          </div>
          <span
            className="shrink-0 max-w-[130px] truncate text-[11px] text-muted"
            title={rootPath ? currentWs?.name : undefined}
          >
            {rootPath ? `into ${currentWs?.name || 'workspace'}` : 'no folder open'}
          </span>
          <IconBtn title="Refresh catalog" onClick={() => void loadIndex(true)}>
            <ArrowsClockwise size={15} className={loading ? 'animate-spin' : undefined} />
          </IconBtn>
          <IconBtn title="Skill sources & settings" onClick={() => useUIStore.getState().openSettings('skills')}>
            <SlidersHorizontal size={15} />
          </IconBtn>
        </div>

        {error && (
          <div className="mx-2 mb-1.5 px-2.5 py-1.5 text-[11px] text-red-400 bg-red-600/10 rounded-md flex items-start gap-2">
            <span className="flex-1 whitespace-pre-wrap break-words">{error}</span>
            <button onClick={() => setError(null)} className="text-muted hover:text-primary"><X size={12} /></button>
          </div>
        )}

        {/* Lists */}
        <div className="flex-1 overflow-y-auto pb-2">
          {installedRows.length > 0 && (
            <>
              <GroupLabel>Installed · {installedRows.length}</GroupLabel>
              {installedRows.map((e) => renderRow(e, true))}
            </>
          )}

          {savedRows.length > 0 && (
            <>
              <GroupLabel>Saved · {savedRows.length}</GroupLabel>
              {savedRows.map((e) => renderRow(e, false))}
            </>
          )}

          <GroupLabel>Browse{browseRows.length > 0 && ` · ${browseRows.length}`}</GroupLabel>
          {loading && browseRows.length === 0 ? (
            <div className="px-4 py-6 text-center text-[13px] text-muted">Loading…</div>
          ) : browseRows.length === 0 ? (
            <div className="px-4 py-6 text-center text-[13px] text-muted">
              {index.length === 0
                ? 'No catalog yet. Add a repo in Settings → Skills.'
                : empty
                  ? 'No matches.'
                  : terms.length
                    ? 'No other catalog matches.'
                    : 'Everything in the catalog is already here.'}
            </div>
          ) : (
            browseRows.map((e) => renderRow(e, false))
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// One skill row — a save toggle (bookmark + cache), the name + "Installed" tag,
// and Install ▾ (per-agent menu for the current workspace).
// ---------------------------------------------------------------------------

function SkillRow({
  entry,
  installed,
  saved,
  rootPath,
  installedKeys,
  onChanged,
  onError,
}: {
  entry: SkillEntry
  installed: boolean
  saved: boolean
  rootPath: string
  installedKeys: Set<string>
  onChanged: () => void
  onError: (m: string | null) => void
}) {
  const installRef = useRef<HTMLButtonElement>(null)
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; left: number } | null>(null)
  const [saveBusy, setSaveBusy] = useState(false)
  const link = sourceUrl(entry)

  const openMenu = () => {
    const r = installRef.current?.getBoundingClientRect()
    if (r) setMenuAnchor({ top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 208) })
  }

  const toggleSave = async () => {
    onError(null)
    setSaveBusy(true)
    try {
      if (saved) {
        await api().skillsUnsave(entry.id)
      } else {
        const res = await api().skillsSave(entry)
        if (!res.ok) onError(errorMessage(res.error, 'Could not save skill.'))
      }
      onChanged()
    } catch (err) {
      onError(errorMessage(err))
    } finally {
      setSaveBusy(false)
    }
  }

  return (
    <div className="group flex items-center gap-2 mx-1.5 px-2 py-1.5 rounded-md hover:bg-surface-5/60">
      <button
        onClick={() => void toggleSave()}
        disabled={saveBusy}
        title={saved ? 'Saved — click to remove from your library' : 'Save to your library (cached for reuse)'}
        className="shrink-0 w-6 h-6 flex items-center justify-center rounded disabled:opacity-50"
      >
        {saveBusy ? (
          <CircleNotch size={13} className="animate-spin text-muted" />
        ) : (
          <BookmarkSimple
            size={15}
            weight={saved ? 'fill' : 'regular'}
            className={saved ? 'text-accent' : 'text-muted hover:text-secondary'}
          />
        )}
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[12.5px] font-mono text-primary truncate">{entry.name}</span>
          {typeof entry.stars === 'number' && entry.stars > 0 && (
            <span className="shrink-0 text-[10px] text-muted tabular-nums">
              {entry.stars > 999 ? `${Math.round(entry.stars / 1000)}k` : entry.stars}★
            </span>
          )}
        </div>
        {entry.description && <div className="text-[11px] text-muted truncate">{entry.description}</div>}
      </div>

      {link && (
        <button
          onClick={() => window.electronAPI?.openExternalUrl(link)}
          title="Open skill on GitHub"
          className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-muted hover:text-secondary opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        >
          <ArrowSquareOut size={14} />
        </button>
      )}

      <button
        ref={installRef}
        onClick={openMenu}
        disabled={!rootPath}
        className={`shrink-0 flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 disabled:opacity-40 ${
          installed ? 'text-secondary hover:text-primary' : 'text-primary'
        }`}
        title={rootPath ? 'Install for an agent in this workspace' : 'Open a folder first'}
      >
        {installed ? 'Agents' : 'Install'}
        <CaretDown size={10} className="opacity-60" />
      </button>

      {menuAnchor && (
        <AgentMenu
          entry={entry}
          anchor={menuAnchor}
          triggerRef={installRef}
          rootPath={rootPath}
          installedKeys={installedKeys}
          onChanged={onChanged}
          onError={onError}
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Agent menu — a single-column popover of agents for the CURRENT workspace.
// Clicking toggles install/uninstall there; a check marks installed agents.
// ---------------------------------------------------------------------------

function AgentMenu({
  entry,
  anchor,
  triggerRef,
  rootPath,
  installedKeys,
  onChanged,
  onError,
  onClose,
}: {
  entry: SkillEntry
  anchor: { top: number; left: number }
  triggerRef: React.RefObject<HTMLButtonElement>
  rootPath: string
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
    if (!rootPath) return
    const on = installedKeys.has(`${entry.id}:${targetId}`)
    onError(null)
    setBusy(targetId)
    try {
      if (on) {
        const res = await api().skillsUninstall(entry.id, entry.name, targetId, rootPath)
        if (!res.ok) onError(errorMessage(res.error, 'Could not remove skill.'))
      } else {
        const res = await api().skillsInstall(entry, targetId, rootPath)
        if (!res.ok) onError(errorMessage(res.error, 'Could not install skill.'))
        else if (res.warnings?.length) onError(res.warnings.join('\n'))
      }
      onChanged()
    } catch (err) {
      onError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return createPortal(
    <div
      ref={rootRef}
      className="fixed z-[1000] w-[200px] rounded-lg border border-subtle bg-surface-3 shadow-xl py-1 text-xs"
      style={{ top: anchor.top, left: anchor.left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-2.5 pt-0.5 pb-1 text-[10px] uppercase tracking-wide text-muted select-none">Install for</div>
      {SKILL_TARGETS.map((t) => {
        const on = installedKeys.has(`${entry.id}:${t.id}`)
        const working = busy === t.id
        return (
          <button
            key={t.id}
            onClick={() => void toggle(t.id)}
            disabled={working}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-secondary hover:bg-surface-4 hover:text-primary disabled:opacity-50"
            title={on ? 'Installed — click to remove' : 'Install here'}
          >
            <span className="w-3.5 shrink-0 flex items-center justify-center text-accent">
              {working ? <CircleNotch size={11} className="animate-spin" /> : on ? <Check size={11} weight="bold" /> : null}
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

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

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
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex items-center justify-center w-7 h-7 rounded-md text-muted hover:text-primary hover:bg-white/5 transition-colors"
    >
      {children}
    </button>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-3.5 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted select-none">{children}</div>
}
