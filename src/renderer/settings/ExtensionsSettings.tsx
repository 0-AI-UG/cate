// =============================================================================
// ExtensionsSettings — manage extensions from the remote catalog and from local
// sideloaded folders.
//
// Three subsections:
//   1. Catalog — browse catalog entries; install (download), enable/disable, and
//      manage installed ones (update / reinstall / remove). Opening an
//      extension's panels happens from the canvas toolbar, not here.
//   2. Sideloaded — local dev folders added via "Add local folder…", removable.
//   3. Catalog sources — view/add/remove catalog source URLs and refresh.
//
// The extension list is read from extensionsStore, whose single module-level
// subscription re-fetches on every EXTENSIONS_CHANGED broadcast (enable/disable/
// uninstall/reinstall/update/sideload/catalog-refresh). Only install does NOT
// broadcast, so that path alone still triggers an explicit store refresh.
// Styling mirrors SkillsSettings.
// =============================================================================

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Plus, Trash, CircleNotch, ArrowsClockwise, ArrowCircleUp, Warning, CaretRight } from '@phosphor-icons/react'
import { SettingRow, SearchableBlock, SecondaryButton, Toggle, TextInput } from './SettingsComponents'
import { Tooltip } from '../ui/Tooltip'
import { errorMessage } from '../lib/errorMessage'
import { useExtensionsStore, ensureExtensionsStarted } from '../stores/extensionsStore'
import type { ExtensionListEntry } from '../../shared/extensions'

const api = () => window.electronAPI

// Human-readable labels for the manifest `cateApi` scopes — what the extension
// is allowed to do. A bare namespace (e.g. `editor`) covers its sub-scopes;
// unknown scopes fall back to the raw string so nothing is hidden.
const PERMISSION_LABELS: Record<string, string> = {
  'workspace.read': 'Read workspace info',
  theme: 'Read the theme',
  ui: 'Show notifications',
  editor: 'Open & edit files',
  'editor.read': 'Read the active editor',
  'editor.write': 'Open files in the editor',
  storage: 'Store extension data',
  canvas: 'Create canvas panels',
  agent: 'Run the agent on your behalf',
  browser: 'Control the browser',
  files: 'Receive dropped files',
  'files.drop': 'Receive dropped files',
}

/** A small muted icon button (reinstall / remove / remove source).
 *  Hoisted to module scope so it isn't redefined on every ExtensionsSettings
 *  render (which would remount its subtrees on every keystroke). */
const IconAction = ({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  children: ReactNode
}) => (
  <Tooltip label={label}>
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`shrink-0 p-0.5 rounded text-muted disabled:opacity-30 ${
        danger ? 'hover:text-red-400' : 'hover:text-primary'
      }`}
    >
      {children}
    </button>
  </Tooltip>
)

/** The extension's declared `cateApi` scopes as readable permission chips,
 *  shown in the expanded row body. Renders nothing when none are declared. */
const Permissions = ({ scopes }: { scopes?: string[] }) => {
  if (!scopes || scopes.length === 0) return null
  // Dedup after mapping — e.g. `files` and `files.drop` share one label.
  const labels = [...new Set(scopes.map((s) => PERMISSION_LABELS[s] ?? s))]
  return (
    <div className="flex flex-wrap items-center gap-1">
      {labels.map((l) => (
        <span key={l} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-3 text-muted">
          {l}
        </span>
      ))}
    </div>
  )
}

/** The shared expandable-row shell for a single extension: caret + name +
 *  version, a caller-supplied `middle` cluster (badges / id / description), a
 *  stopPropagation action cluster (`actions`), the expanded detail body
 *  (`detail`, always ending in Permissions), and an optional `footer` (row
 *  error). Hoisted to module scope so it isn't a fresh component type on every
 *  ExtensionsSettings render. Both the catalog and sideload rows use it. */
const ExtensionRow = ({
  name,
  version,
  open,
  onToggleExpand,
  middle,
  actions,
  detail,
  footer,
}: {
  name: string
  version?: string
  open: boolean
  onToggleExpand: () => void
  middle: ReactNode
  actions: ReactNode
  detail: ReactNode
  footer?: ReactNode
}) => (
  <div className="px-3 py-2 border-b border-subtle last:border-0 hover:bg-hover">
    <div className="flex items-center gap-2.5 cursor-pointer" onClick={onToggleExpand}>
      <CaretRight
        size={10}
        className={`shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`}
      />
      <span className="shrink-0 max-w-[45%] truncate text-[12px] text-primary">{name}</span>
      {version && <span className="shrink-0 text-[10px] text-muted font-mono">v{version}</span>}
      {middle}
      <div className="flex items-center gap-2.5" onClick={(e) => e.stopPropagation()}>
        {actions}
      </div>
    </div>

    {open && <div className="mt-2 pl-5 flex flex-col gap-1.5">{detail}</div>}

    {footer}
  </div>
)

export function ExtensionsSettings() {
  const entries = useExtensionsStore((s) => s.entries)
  const refresh = useExtensionsStore((s) => s.refresh)
  const [sources, setSources] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Per-extension-id inline error (e.g. failed install).
  const [rowErr, setRowErr] = useState<Record<string, string>>({})
  // Ids of extensions whose install/enable action is in flight.
  const [pending, setPending] = useState<Set<string>>(new Set())
  // Catalog-sources management.
  const [newSource, setNewSource] = useState('')
  const [sourceErr, setSourceErr] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [addingSource, setAddingSource] = useState(false)
  // True until the first list fetch resolves, so we show "Loading catalog…"
  // instead of a misleading "no extensions" message while the first-run
  // background catalog fetch is still in flight.
  const [initialLoad, setInitialLoad] = useState(true)
  // Accordion state: keys of rows whose detail body (id, description,
  // permissions) is expanded. Keyed by `source:id` so a sideloaded copy of a
  // catalog extension can't collide.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const refreshSources = useCallback(async () => {
    try {
      setSources(await api().extensionCatalogSources())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    // The store owns the entries list + its EXTENSIONS_CHANGED subscription.
    ensureExtensionsStarted()
    // Await one refresh purely to clear the "Loading catalog…" placeholder once
    // the first fetch (or an already-populated store) settles.
    void refresh().finally(() => setInitialLoad(false))
    void refreshSources()
  }, [refresh, refreshSources])

  const setPendingFor = (id: string, on: boolean) =>
    setPending((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const addFolder = async () => {
    setErr(null)
    const folderPath = await api().openFolderDialog()
    if (!folderPath) return
    setBusy(true)
    try {
      const res = await api().extensionAddSideload(folderPath)
      if (!res.ok) setErr(errorMessage(res.error, 'Could not load that folder as an extension.'))
      // Success broadcasts EXTENSIONS_CHANGED; the store refreshes itself.
    } finally {
      setBusy(false)
    }
  }

  const removeSideload = async (rootDir: string) => {
    // Broadcasts EXTENSIONS_CHANGED; the store refreshes itself.
    await api().extensionRemoveSideload(rootDir)
  }

  const toggle = async (entry: ExtensionListEntry) => {
    // enable/disable broadcast EXTENSIONS_CHANGED; the store refreshes itself.
    if (entry.enabled) await api().extensionDisable(entry.manifest.id)
    else await api().extensionEnable(entry.manifest.id)
  }

  const install = async (entry: ExtensionListEntry) => {
    const id = entry.manifest.id
    setRowErr((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setPendingFor(id, true)
    try {
      const res = await api().extensionInstall(id)
      if (!res.ok) {
        setRowErr((prev) => ({ ...prev, [id]: errorMessage(res.error, 'Could not install this extension.') }))
      }
      // Install does NOT broadcast EXTENSIONS_CHANGED, so refresh explicitly.
      await refresh()
    } finally {
      setPendingFor(id, false)
    }
  }

  // Run a manage action (uninstall / reinstall / update) that returns an
  // {ok,error} result, surfacing failures inline on the row.
  const runManage = async (
    id: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    fallbackMsg: string,
  ) => {
    setRowErr((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setPendingFor(id, true)
    try {
      const res = await fn()
      if (!res.ok) setRowErr((prev) => ({ ...prev, [id]: errorMessage(res.error, fallbackMsg) }))
      // uninstall/reinstall/update broadcast EXTENSIONS_CHANGED; store refreshes.
    } finally {
      setPendingFor(id, false)
    }
  }

  const uninstall = (id: string) =>
    runManage(id, () => api().extensionUninstall(id), 'Could not remove this extension.')
  const reinstall = (id: string) =>
    runManage(id, () => api().extensionReinstall(id), 'Could not reinstall this extension.')
  const update = (id: string) =>
    runManage(id, () => api().extensionUpdate(id), 'Could not update this extension.')

  const refreshCatalog = async () => {
    setSourceErr(null)
    setRefreshing(true)
    try {
      const res = await api().extensionCatalogRefresh()
      if (!res.ok) setSourceErr(errorMessage(res.error, 'Could not refresh the catalog.'))
      // Broadcasts EXTENSIONS_CHANGED; the store refreshes itself.
    } finally {
      setRefreshing(false)
    }
  }

  const addSource = async () => {
    const url = newSource.trim()
    if (!url) return
    setSourceErr(null)
    setAddingSource(true)
    try {
      const res = await api().extensionAddCatalogSource(url)
      if (!res.ok) {
        setSourceErr(errorMessage(res.error, 'Could not add that catalog source.'))
      } else {
        setNewSource('')
        await refreshSources()
        // addCatalogSource refreshes the catalog, which broadcasts; store updates.
      }
    } finally {
      setAddingSource(false)
    }
  }

  const removeSource = async (url: string) => {
    await api().extensionRemoveCatalogSource(url)
    await refreshSources()
    // removeCatalogSource refreshes the catalog, which broadcasts; store updates.
  }

  const catalogEntries = entries.filter((e) => e.source === 'catalog')
  const sideloadEntries = entries.filter((e) => e.source === 'sideload')

  // ---------------------------------------------------------------------------
  // Shared rows
  // ---------------------------------------------------------------------------

  /** A sideloaded extension row — always installed, removable, enable/disable.
   *  Clicking the row expands its detail body (id, folder, permissions). */
  const renderSideloadRow = (entry: ExtensionListEntry) => {
    const m = entry.manifest
    const key = `sideload:${m.id}`
    const open = expanded.has(key)
    return (
      <ExtensionRow
        key={key}
        name={m.name}
        version={m.version}
        open={open}
        onToggleExpand={() => toggleExpanded(key)}
        middle={
          <>
            <span className="shrink-0 text-[10px] text-muted px-1.5 py-0.5 rounded bg-surface-3">local</span>
            <span className="flex-1 min-w-0 text-[11px] text-muted font-mono truncate">{m.id}</span>
          </>
        }
        actions={
          <>
            <IconAction label="Remove" danger onClick={() => void removeSideload(entry.rootDir)}>
              <Trash size={12} />
            </IconAction>
            <Toggle checked={entry.enabled} onChange={() => void toggle(entry)} />
          </>
        }
        detail={
          <>
            <div className="text-[11px] text-muted font-mono break-all">{entry.rootDir}</div>
            <Permissions scopes={m.cateApi} />
          </>
        }
      />
    )
  }

  /** A catalog extension row — Install (if not installed), or the enable/disable
   *  toggle plus manage actions (update / reinstall / remove) when installed.
   *  Panels are opened from the canvas toolbar, not here. */
  const renderCatalogRow = (entry: ExtensionListEntry) => {
    const m = entry.manifest
    const id = m.id
    const inFlight = pending.has(id)
    const version = entry.version ?? m.version
    const description = entry.description
    const key = `catalog:${id}`
    const open = expanded.has(key)
    return (
      <ExtensionRow
        key={key}
        name={m.name}
        version={version}
        open={open}
        onToggleExpand={() => toggleExpanded(key)}
        middle={<span className="flex-1 min-w-0 text-[11px] text-muted truncate">{description}</span>}
        actions={
          !entry.installed ? (
            <SecondaryButton onClick={() => void install(entry)} disabled={inFlight}>
              {inFlight ? <CircleNotch size={11} className="animate-spin" /> : <Plus size={11} />}
              {inFlight ? 'Installing…' : 'Install'}
            </SecondaryButton>
          ) : (
            <>
              {inFlight && <CircleNotch size={12} className="animate-spin text-muted shrink-0" />}
              {entry.updateAvailable && (
                <SecondaryButton onClick={() => void update(id)} disabled={inFlight}>
                  <ArrowCircleUp size={11} />
                  Update
                </SecondaryButton>
              )}
              <IconAction label="Reinstall" disabled={inFlight} onClick={() => void reinstall(id)}>
                <ArrowsClockwise size={12} />
              </IconAction>
              <IconAction label="Remove" danger disabled={inFlight} onClick={() => void uninstall(id)}>
                <Trash size={12} />
              </IconAction>
              <Toggle checked={entry.enabled} onChange={() => void toggle(entry)} />
            </>
          )
        }
        detail={
          <>
            <div className="text-[11px] text-muted font-mono">{id}</div>
            {description && (
              <div className="text-[11px] text-secondary leading-relaxed">{description}</div>
            )}
            <Permissions scopes={m.cateApi} />
          </>
        }
        footer={
          rowErr[id] ? (
            <div className="text-[11px] text-red-400 mt-1 pl-5">{rowErr[id]}</div>
          ) : undefined
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-1">
      {/* ---- Catalog browser ------------------------------------------------ */}
      <SearchableBlock keywords="extensions catalog browse install remote plugin marketplace">
        <div className="flex items-center justify-between pt-1">
          <span className="text-sm text-primary">Catalog</span>
          <SecondaryButton onClick={() => void refreshCatalog()} disabled={refreshing}>
            {refreshing ? (
              <CircleNotch size={11} className="animate-spin" />
            ) : (
              <ArrowsClockwise size={11} />
            )}
            {refreshing ? 'Refreshing…' : 'Refresh catalog'}
          </SecondaryButton>
        </div>

        {catalogEntries.length > 0 ? (
          <div className="my-2 rounded-lg border border-subtle overflow-hidden">
            {catalogEntries.map(renderCatalogRow)}
          </div>
        ) : refreshing || initialLoad ? (
          <p className="text-[11px] text-muted px-1 py-2">Loading catalog…</p>
        ) : sources.length === 0 ? (
          <p className="text-[11px] text-muted px-1 py-2">
            No catalog sources configured. Add one below, then refresh.
          </p>
        ) : (
          <p className="text-[11px] text-muted px-1 py-2">
            No catalog extensions found. Use “Refresh catalog” above to fetch from your sources.
          </p>
        )}
      </SearchableBlock>

      {/* ---- Sideloaded ----------------------------------------------------- */}
      <SettingRow
        label="Add local folder"
        description="Load an extension from a folder on disk (sideload). The folder must contain an extension manifest."
      >
        <SecondaryButton onClick={() => void addFolder()} disabled={busy}>
          <Plus size={11} />
          Add local folder…
        </SecondaryButton>
      </SettingRow>

      {err && <div className="text-[11px] text-red-400 -mt-1 mb-1">{err}</div>}

      {sideloadEntries.length > 0 && (
        <SearchableBlock keywords="extensions sideload local panels enable disable plugin">
          <div className="my-2 rounded-lg border border-subtle overflow-hidden">
            {sideloadEntries.map(renderSideloadRow)}
          </div>
        </SearchableBlock>
      )}

      {/* ---- Catalog sources ------------------------------------------------ */}
      <SearchableBlock keywords="extensions catalog source url registry add remove">
        <div className="mt-3">
          <span className="text-sm text-primary">Catalog sources</span>
          <p className="text-xs text-muted mt-0.5">
            Remote URLs Cate fetches the extension catalog from.
          </p>

          <div className="my-2 flex items-start gap-2.5 rounded-md border border-subtle bg-surface-2 px-3 py-2">
            <Warning size={13} className="mt-0.5 shrink-0 text-amber-400/80" />
            <p className="text-[11px] leading-relaxed text-muted">
              Only add sources you trust. An extension can run its own code on your machine, so a
              malicious catalog can do anything you can. Stick to the official Cate catalog (governed
              by the Cate team), or build and sideload your own extensions.
            </p>
          </div>

          <div className="my-2 flex items-center gap-2">
            <TextInput
              value={newSource}
              onChange={setNewSource}
              placeholder="https://example.com/catalog.json"
              layoutClassName="flex-1 px-2"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addSource()
              }}
              disabled={addingSource}
            />
            <SecondaryButton onClick={() => void addSource()} disabled={addingSource || newSource.trim() === ''}>
              {addingSource ? <CircleNotch size={11} className="animate-spin" /> : <Plus size={11} />}
              Add source
            </SecondaryButton>
          </div>

          {sourceErr && <div className="text-[11px] text-red-400 mb-1">{sourceErr}</div>}

          {sources.length > 0 ? (
            <div className="rounded-lg border border-subtle overflow-hidden">
              {sources.map((url) => (
                <div
                  key={url}
                  className="flex items-center gap-2.5 px-3 py-2 border-b border-subtle last:border-0 hover:bg-hover"
                >
                  <span className="flex-1 min-w-0 text-[11px] text-secondary font-mono truncate">{url}</span>
                  <IconAction label="Remove source" danger onClick={() => void removeSource(url)}>
                    <Trash size={12} />
                  </IconAction>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted px-1 py-2">No catalog sources configured.</p>
          )}
        </div>
      </SearchableBlock>
    </div>
  )
}
