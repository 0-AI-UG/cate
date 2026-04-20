// =============================================================================
// SavedLayoutsDialog — Manager for named canvas layouts.
// Save the current canvas arrangement, load one, or delete it.
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react'
import { FloppyDisk, Trash, FolderOpen, SquaresFour } from '@phosphor-icons/react'
import { useUIStore } from '../stores/uiStore'
import { useAppStore, getWorkspaceCanvasStore } from '../stores/appStore'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import log from '../lib/logger'

export function SavedLayoutsDialog() {
  const show = useUIStore((s) => s.showLayoutsDialog)
  const setShow = useUIStore((s) => s.setShowLayoutsDialog)
  const canvasApi = useCanvasStoreApi()

  const [names, setNames] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [saveName, setSaveName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await window.electronAPI.layoutList()
      setNames(list.sort((a, b) => a.localeCompare(b)))
    } catch (err) {
      log.warn('[SavedLayoutsDialog] list failed', err)
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

  const close = useCallback(() => setShow(false), [setShow])

  const buildSnapshot = useCallback(() => {
    const state = canvasApi.getState()
    const appState = useAppStore.getState()
    const workspace = appState.workspaces.find((w) => w.id === appState.selectedWorkspaceId)
    return {
      nodes: Object.values(state.nodes).map((n) => {
        const panel = workspace?.panels[n.panelId]
        return {
          panelType: panel?.type ?? 'terminal',
          origin: n.origin,
          size: n.size,
          filePath: panel?.filePath,
          url: panel?.url,
        }
      }),
      regions: Object.values(state.regions).map((r) => ({
        origin: r.origin, size: r.size, label: r.label, color: r.color,
      })),
      zoomLevel: state.zoomLevel,
      viewportOffset: state.viewportOffset,
    }
  }, [canvasApi])

  const handleSave = useCallback(async () => {
    const name = saveName.trim()
    if (!name) { setError('Name is required'); return }
    setBusy(true); setError(null)
    try {
      await window.electronAPI.layoutSave(name, buildSnapshot())
      setSaveName('')
      await refresh()
      setSelected(name)
    } catch (err) {
      log.error('[SavedLayoutsDialog] save failed', err)
      setError('Save failed')
    } finally {
      setBusy(false)
    }
  }, [saveName, buildSnapshot, refresh])

  const handleLoad = useCallback(async (name: string) => {
    setBusy(true); setError(null)
    try {
      const snap = await window.electronAPI.layoutLoad(name) as
        | { nodes?: Array<{ panelType: string; origin: { x: number; y: number }; size: { width: number; height: number }; filePath?: string; url?: string }>; regions?: Array<{ label: string; origin: { x: number; y: number }; size: { width: number; height: number }; color?: string }> }
        | null
      if (!snap) { setError('Layout not found'); return }
      const wsId = useAppStore.getState().selectedWorkspaceId
      const app = useAppStore.getState()
      app.closeAllPanels(wsId)
      // closeAllPanels wipes every panel — including the 'canvas' host panel
      // that owns the dock center zone. Recreate it before we start adding
      // nodes so the fresh canvas exists to receive them.
      app.ensureCenterCanvas(wsId)
      for (const node of snap.nodes ?? []) {
        switch (node.panelType) {
          case 'terminal': useAppStore.getState().createTerminal(wsId, undefined, node.origin); break
          case 'editor':   useAppStore.getState().createEditor(wsId, node.filePath, node.origin); break
          case 'browser':  useAppStore.getState().createBrowser(wsId, node.url, node.origin); break
        }
      }
      // Use the *new* canvas store, not the one captured at mount time — the
      // previous one was disposed along with its panel.
      const freshCanvas = getWorkspaceCanvasStore(wsId) ?? canvasApi
      for (const region of snap.regions ?? []) {
        freshCanvas.getState().addRegion(region.label, region.origin, region.size, region.color)
      }
      freshCanvas.getState().zoomToFit()
      close()
    } catch (err) {
      log.error('[SavedLayoutsDialog] load failed', err)
      setError('Load failed')
    } finally {
      setBusy(false)
    }
  }, [canvasApi, close])

  const handleDelete = useCallback(async (name: string) => {
    if (!window.confirm(`Delete layout "${name}"?`)) return
    setBusy(true); setError(null)
    try {
      await window.electronAPI.layoutDelete(name)
      if (selected === name) setSelected(null)
      await refresh()
    } catch (err) {
      log.error('[SavedLayoutsDialog] delete failed', err)
      setError('Delete failed')
    } finally {
      setBusy(false)
    }
  }, [selected, refresh])

  // Escape to close
  useEffect(() => {
    if (!show) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close() }
    }
    document.addEventListener('keydown', handler, { capture: true })
    return () => document.removeEventListener('keydown', handler, { capture: true })
  }, [show, close])

  if (!show) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-40 bg-black/40"
      onClick={close}
    >
      <div
        className="w-[640px] max-h-[560px] rounded-3xl overflow-hidden flex flex-col bg-surface-4/85 backdrop-blur-2xl border border-white/20 shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Save input — primary action, mirrors the search-bar treatment */}
        <div className="flex items-center gap-3 px-5 h-14">
          <FloppyDisk size={20} className="text-muted shrink-0" weight="bold" />
          <input
            autoFocus
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
            className="flex-1 bg-transparent text-primary text-base font-medium outline-none placeholder:text-muted placeholder:font-normal"
            placeholder="Save current canvas as…"
            disabled={busy}
          />
          <button
            onClick={handleSave}
            disabled={busy || !saveName.trim()}
            className="text-xs font-medium px-3 py-1.5 rounded-full bg-blue-600/80 text-white hover:bg-blue-600 disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
          >
            Save
          </button>
        </div>

        {error && (
          <div className="mx-2 mb-2 px-3 py-2 text-xs text-red-400 bg-red-600/10 rounded-lg">
            {error}
          </div>
        )}

        {/* Layout list */}
        <div className="flex-1 overflow-y-auto pb-2">
          {names.length === 0 ? (
            <div className="px-5 py-8 text-sm text-muted text-center">
              No saved layouts yet. Type a name above and hit Enter.
            </div>
          ) : (
            <>
              <div className="mx-5 my-1 border-t border-white/10" />
              {names.map((name) => {
                const isSelected = selected === name
                return (
                  <div
                    key={name}
                    className={`group flex items-center gap-3 mx-2 px-3 py-2 cursor-pointer rounded-lg ${
                      isSelected ? 'bg-blue-600/30' : 'hover:bg-white/5'
                    }`}
                    onClick={() => setSelected(name)}
                    onDoubleClick={() => handleLoad(name)}
                  >
                    <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-violet-500/15 text-violet-400">
                      <SquaresFour size={16} weight="bold" />
                    </div>
                    <span className="flex-1 text-primary text-sm font-medium truncate">{name}</span>
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
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(name) }}
                        disabled={busy}
                        className="p-1.5 rounded-md text-muted hover:text-red-400 hover:bg-red-600/10"
                        title="Delete"
                      >
                        <Trash size={12} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
