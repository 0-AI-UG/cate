// =============================================================================
// ExtensionsSettings — manage extensions from the remote catalog and from local
// sideloaded folders.
//
// Three subsections:
//   1. Catalog — browse catalog entries; install (download), enable, or (once
//      enabled) open per-panel. Shares the enabled-extension row rendering with
//      the sideload subsection so installed catalog extensions look identical.
//   2. Sideloaded — local dev folders added via "Add local folder…", removable.
//   3. Catalog sources — view/add/remove catalog source URLs and refresh.
//
// The list refreshes whenever the main process broadcasts a change
// (enable/disable/install) and after any local install/refresh action resolves.
// Styling mirrors SkillsSettings.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash, PuzzlePiece, CircleNotch, ArrowsClockwise } from '@phosphor-icons/react'
import { SettingRow, SearchableBlock, SecondaryButton, Toggle, TextInput } from './SettingsComponents'
import { Tooltip } from '../ui/Tooltip'
import { errorMessage } from '../lib/errorMessage'
import { useAppStore } from '../stores/appStore'
import { resolveExtensionPanelMeta, type ExtensionManifest, type ExtensionPanelDef } from '../../shared/extensions'
import type { ExtensionListEntry } from '../../shared/extensions'

const api = () => window.electronAPI

/** Display metadata for one extension panel — label/icon resolved from the
 *  manifest, with a sensible fallback to the raw panel id. Colocated so callers
 *  that need a panel title (e.g. the open button / reverse-API titling) share
 *  one resolver. */
export function extensionPanelDisplay(
  manifest: ExtensionManifest | undefined,
  extensionPanelId: string,
): { label: string; icon?: string } {
  const meta: ExtensionPanelDef | null = resolveExtensionPanelMeta(manifest, extensionPanelId)
  return { label: meta?.label ?? extensionPanelId, icon: meta?.icon }
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
    void refresh()
    void refreshSources()
    // Re-pull whenever main reports the extension set changed.
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

  const enable = async (entry: ExtensionListEntry) => {
    const id = entry.manifest.id
    setPendingFor(id, true)
    try {
      await api().extensionEnable(id)
      await refresh()
    } finally {
      setPendingFor(id, false)
    }
  }

  const openPanel = (entry: ExtensionListEntry, panel: ExtensionPanelDef) => {
    const wsId = useAppStore.getState().selectedWorkspaceId
    if (!wsId) return
    useAppStore.getState().createExtensionPanel(
      wsId,
      entry.manifest.id,
      panel.id,
      undefined,
      undefined,
      panel.label,
    )
  }

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

  /** The per-panel "open" buttons shown for an enabled extension. Shared so a
   *  catalog and a sideloaded enabled extension render identically. */
  const renderOpenButtons = (entry: ExtensionListEntry) => {
    const m = entry.manifest
    if (!entry.enabled || m.panels.length === 0) return null
    return (
      <div className="flex flex-wrap gap-1.5 pl-6">
        {m.panels.map((p) => (
          <button
            key={p.id}
            onClick={() => openPanel(entry, p)}
            className="px-2 py-1 text-[11px] rounded border border-subtle text-secondary hover:bg-surface-3 hover:text-primary transition-colors"
          >
            {extensionPanelDisplay(m, p.id).label}
          </button>
        ))}
      </div>
    )
  }

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
          <Tooltip label="Remove">
            <button
              onClick={() => void removeSideload(entry.rootDir)}
              className="shrink-0 p-0.5 rounded text-muted opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
              aria-label="Remove"
            >
              <Trash size={12} />
            </button>
          </Tooltip>
        </div>
        {renderOpenButtons(entry)}
      </div>
    )
  }

  /** A catalog extension row — Install (if not installed), Enable (installed but
   *  off), or the enable/disable toggle + open buttons (enabled). */
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
            </div>
            <div className="text-[11px] text-muted font-mono truncate">{id}</div>
            {description && <div className="text-[11px] text-muted truncate">{description}</div>}
          </div>

          {!entry.installed && (
            <SecondaryButton onClick={() => void install(entry)} disabled={inFlight}>
              {inFlight ? <CircleNotch size={11} className="animate-spin" /> : <Plus size={11} />}
              {inFlight ? 'Installing…' : 'Install'}
            </SecondaryButton>
          )}

          {entry.installed && !entry.enabled && (
            <SecondaryButton onClick={() => void enable(entry)} disabled={inFlight}>
              {inFlight ? <CircleNotch size={11} className="animate-spin" /> : null}
              Enable
            </SecondaryButton>
          )}

          {entry.installed && entry.enabled && (
            <Toggle checked={entry.enabled} onChange={() => void toggle(entry)} />
          )}
        </div>

        {rowErr[id] && <div className="text-[11px] text-red-400 pl-6">{rowErr[id]}</div>}

        {renderOpenButtons(entry)}
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
        ) : (
          <p className="text-[11px] text-muted px-1 py-2">
            No catalog extensions. Add a catalog source below and refresh.
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
