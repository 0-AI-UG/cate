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
// The list refreshes whenever the main process broadcasts a change
// (enable/disable/install) and after any local install/refresh action resolves.
// Styling mirrors SkillsSettings.
// =============================================================================

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Plus, Trash, PuzzlePiece, CircleNotch, ArrowsClockwise, ArrowCircleUp, Warning } from '@phosphor-icons/react'
import { SettingRow, SearchableBlock, SecondaryButton, Toggle, TextInput } from './SettingsComponents'
import { Tooltip } from '../ui/Tooltip'
import { errorMessage } from '../lib/errorMessage'
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
  files: 'Receive dropped files',
  'files.drop': 'Receive dropped files',
}

/** The extension's declared `cateApi` scopes shown as readable permission chips.
 *  Renders nothing when none are declared. */
const Permissions = ({ scopes }: { scopes?: string[] }) => {
  if (!scopes || scopes.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1 pl-6">
      <span className="text-[10px] text-muted">Permissions:</span>
      {scopes.map((s) => (
        <span
          key={s}
          title={s}
          className="text-[10px] px-1.5 py-0.5 rounded bg-surface-3 text-muted"
        >
          {PERMISSION_LABELS[s] ?? s}
        </span>
      ))}
    </div>
  )
}

export function ExtensionsSettings() {
  const [entries, setEntries] = useState<ExtensionListEntry[]>([])
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

  const refresh = useCallback(async () => {
    try {
      setEntries(await api().extensionList())
    } catch {
      /* ignore */
    }
  }, [])

  const refreshSources = useCallback(async () => {
    try {
      setSources(await api().extensionCatalogSources())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refresh().finally(() => setInitialLoad(false))
    void refreshSources()
    // Re-pull whenever main reports the extension set changed (including the
    // first-run background catalog fetch completing).
    return api().onExtensionsChanged(() => void refresh())
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
      else await refresh()
    } finally {
      setBusy(false)
    }
  }

  const removeSideload = async (rootDir: string) => {
    await api().extensionRemoveSideload(rootDir)
    await refresh()
  }

  const toggle = async (entry: ExtensionListEntry) => {
    if (entry.enabled) await api().extensionDisable(entry.manifest.id)
    else await api().extensionEnable(entry.manifest.id)
    await refresh()
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
      await refresh()
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
      await refresh()
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
        await refresh()
      }
    } finally {
      setAddingSource(false)
    }
  }

  const removeSource = async (url: string) => {
    await api().extensionRemoveCatalogSource(url)
    await refreshSources()
    await refresh()
  }

  const catalogEntries = entries.filter((e) => e.source === 'catalog')
  const sideloadEntries = entries.filter((e) => e.source === 'sideload')

  // ---------------------------------------------------------------------------
  // Shared rows
  // ---------------------------------------------------------------------------

  /** A small hover-revealed icon button (matches the sideload Remove affordance). */
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
        className={`shrink-0 p-0.5 rounded text-muted opacity-0 group-hover:opacity-100 disabled:opacity-30 transition-opacity ${
          danger ? 'hover:text-red-400' : 'hover:text-primary'
        }`}
      >
        {children}
      </button>
    </Tooltip>
  )

  /** A sideloaded extension row — always installed, removable, enable/disable. */
  const renderSideloadRow = (entry: ExtensionListEntry) => {
    const m = entry.manifest
    return (
      <div
        key={m.id}
        className="group flex flex-col gap-2 px-3 py-2.5 border-b border-subtle last:border-0 hover:bg-hover"
      >
        <div className="flex items-center gap-2.5">
          <PuzzlePiece size={14} className="text-muted shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-primary truncate">{m.name}</span>
              {m.version && <span className="text-[10px] text-muted font-mono">v{m.version}</span>}
              <span className="text-[10px] text-muted px-1.5 py-0.5 rounded bg-surface-3">local</span>
            </div>
            <div className="text-[11px] text-muted font-mono truncate">{m.id}</div>
          </div>
          <Toggle checked={entry.enabled} onChange={() => void toggle(entry)} />
          <IconAction label="Remove" danger onClick={() => void removeSideload(entry.rootDir)}>
            <Trash size={12} />
          </IconAction>
        </div>
        <Permissions scopes={m.cateApi} />
      </div>
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
    return (
      <div
        key={id}
        className="group flex flex-col gap-2 px-3 py-2.5 border-b border-subtle last:border-0 hover:bg-hover"
      >
        <div className="flex items-center gap-2.5">
          <PuzzlePiece size={14} className="text-muted shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-primary truncate">{m.name}</span>
              {version && <span className="text-[10px] text-muted font-mono">v{version}</span>}
              {entry.updateAvailable && (
                <span className="text-[10px] text-blue-400 px-1.5 py-0.5 rounded bg-blue-500/[0.12]">
                  update available
                </span>
              )}
            </div>
            <div className="text-[11px] text-muted font-mono truncate">{id}</div>
            {description && <div className="text-[11px] text-muted truncate">{description}</div>}
          </div>

          {!entry.installed ? (
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
              <Toggle checked={entry.enabled} onChange={() => void toggle(entry)} />
              <IconAction label="Reinstall" disabled={inFlight} onClick={() => void reinstall(id)}>
                <ArrowsClockwise size={12} />
              </IconAction>
              <IconAction label="Remove" danger disabled={inFlight} onClick={() => void uninstall(id)}>
                <Trash size={12} />
              </IconAction>
            </>
          )}
        </div>

        <Permissions scopes={m.cateApi} />

        {rowErr[id] && <div className="text-[11px] text-red-400 pl-6">{rowErr[id]}</div>}
      </div>
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

          <div className="my-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2">
            <Warning size={14} className="mt-0.5 shrink-0 text-amber-400" />
            <p className="text-[11px] leading-relaxed text-secondary">
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
                  className="group flex items-center gap-2.5 px-3 py-2 border-b border-subtle last:border-0 hover:bg-hover"
                >
                  <span className="flex-1 min-w-0 text-[11px] text-secondary font-mono truncate">{url}</span>
                  <Tooltip label="Remove source">
                    <button
                      onClick={() => void removeSource(url)}
                      className="shrink-0 p-0.5 rounded text-muted opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
                      aria-label="Remove source"
                    >
                      <Trash size={12} />
                    </button>
                  </Tooltip>
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
