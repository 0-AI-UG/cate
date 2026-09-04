// =============================================================================
// SavedLayoutsDialog — Manager for named canvas layouts.
// Save the current canvas arrangement, load one, or delete it. Styled to match
// the Cmd+K command palette (slim rows, dark glass, rounded-xl).
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react'
import { FloppyDisk, Trash, FolderOpen, SquaresFour } from '@phosphor-icons/react'
import { PaletteDialogShell } from '../ui/Modal'
import { useUIStore } from '../stores/uiStore'
import { useOptionalCanvasStoreApi } from '../stores/CanvasStoreContext'
import {
  listLayouts,
  saveLayout,
  deleteLayout,
  loadLayoutIntoActiveCanvas,
} from '../lib/layouts'
import log from '../lib/logger'
import { useEscapeKey } from '../lib/hooks/useEscapeKey'
import { Tooltip } from '../ui/Tooltip'
import { LoadingState, Spinner } from '../ui/Spinner'
import { PaletteTextInput } from '../ui/PaletteTextInput'
import { InlineNotice } from '../ui/InlineNotice'

export function SavedLayoutsDialog() {
  const show = useUIStore((s) => s.showLayoutsDialog)
  const setShow = useUIStore((s) => s.setShowLayoutsDialog)
  const layoutsVersion = useUIStore((s) => s.layoutsVersion)
  const canvasApi = useOptionalCanvasStoreApi()

  const [names, setNames] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [saveName, setSaveName] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setNames(await listLayouts())
    } catch (err) {
      log.warn('[SavedLayoutsDialog] list failed', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (show) {
      refresh()
      setSaveName('')
      setSelected(null)
      setError(null)
    }
  }, [show, refresh])

  // Re-list when a layout is saved/deleted elsewhere while the dialog is open.
  useEffect(() => {
    if (show) refresh()
  }, [layoutsVersion, show, refresh])

  const close = useCallback(() => setShow(false), [setShow])

  const handleSave = useCallback(async () => {
    const name = saveName.trim()
    if (!name) { setError('Name is required'); return }
    setBusy(true); setError(null)
    try {
      if (!canvasApi) return
      await saveLayout(name, canvasApi)
      setSaveName('')
      setSelected(name)
    } catch (err) {
      log.error('[SavedLayoutsDialog] save failed', err)
      setError('Save failed')
    } finally {
      setBusy(false)
    }
  }, [saveName, canvasApi])

  const handleLoad = useCallback(async (name: string) => {
    setBusy(true); setError(null)
    try {
      const ok = await loadLayoutIntoActiveCanvas(name)
      if (ok) close()
      else setError('Layout not found')
    } finally {
      setBusy(false)
    }
  }, [close])

  const handleDelete = useCallback(async (name: string) => {
    if (!window.confirm(`Delete layout "${name}"?`)) return
    setBusy(true); setError(null)
    try {
      await deleteLayout(name)
      if (selected === name) setSelected(null)
    } catch (err) {
      log.error('[SavedLayoutsDialog] delete failed', err)
      setError('Delete failed')
    } finally {
      setBusy(false)
    }
  }, [selected])

  useEscapeKey(show, close)

  if (!show) return null

  return (
    <PaletteDialogShell
      onClose={close}
      ariaLabel="Saved layouts"
      cardClassName="w-[600px] max-w-[600px] max-h-[440px] mt-[120px] overflow-hidden flex flex-col self-start"
    >
        {/* Save input — mirrors the palette's search-bar treatment */}
        <div className="p-2 shrink-0">
          <PaletteTextInput
              icon={<FloppyDisk size={15} />}
              autoFocus
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
              placeholder="Save current canvas as…"
              disabled={busy}
              trailing={busy ? (
              <Spinner size={14} label="Updating layouts" />
            ) : saveName.trim() && (
              <button
                onClick={handleSave}
                disabled={busy}
                className="flex items-center gap-1 shrink-0 disabled:opacity-40"
                title="Save layout"
              >
                <kbd className="min-w-[18px] h-[18px] px-1 rounded border border-strong bg-surface-4 text-secondary text-[10px] leading-none flex items-center justify-center">
                  ↵
                </kbd>
              </button>
            )}
          />
        </div>

        {error && (
          <InlineNotice tone="error" className="mx-2 mb-1.5">{error}</InlineNotice>
        )}

        {/* Layout list */}
        <div className="flex-1 overflow-y-auto pb-1.5">
          {loading ? (
            <LoadingState label="Loading layouts…" size={14} className="py-5 text-[13px]" />
          ) : names.length === 0 ? (
            <div className="text-muted text-[13px] text-center py-5">
              No saved layouts yet. Type a name above and hit Enter.
            </div>
          ) : (
            <>
              <div className="px-3.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
                Saved Layouts
              </div>
              {names.map((name) => {
                const isSelected = selected === name
                return (
                  <div
                    key={name}
                    className={`group flex items-center gap-2.5 mx-1.5 px-2.5 py-1.5 cursor-pointer rounded-md ${
                      isSelected ? 'bg-[rgb(var(--agent-rgb))]/12' : ''
                    }`}
                    onClick={() => setSelected(name)}
                    onDoubleClick={() => handleLoad(name)}
                    onMouseEnter={() => setSelected(name)}
                  >
                    <span className="shrink-0 text-violet-400"><SquaresFour size={16} /></span>
                    <span className="flex-1 text-primary text-[13px] truncate">{name}</span>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleLoad(name) }}
                        disabled={busy}
                        className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-primary"
                        title="Load"
                      >
                        <FolderOpen size={12} />
                        Load
                      </button>
                      <Tooltip label="Delete">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(name) }}
                          disabled={busy}
                          className="p-1.5 rounded-[10px] text-muted hover:text-red-400 hover:bg-red-600/10"
                          aria-label="Delete"
                        >
                          <Trash size={12} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>
    </PaletteDialogShell>
  )
}
