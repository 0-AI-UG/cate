// =============================================================================
// EmptyCanvasOverlay — shown on an empty canvas (with a folder open), including
// a freshly-added 2nd canvas. Offers one-click loading of a saved layout into
// *this* canvas. Renders nothing when there are no saved layouts. Dismissable
// via the close button, "Continue without layout", or Escape.
// =============================================================================

import React, { useEffect, useState, useCallback } from 'react'
import type { StoreApi } from 'zustand'
import { SquaresFour, X } from '@phosphor-icons/react'
import type { CanvasStore } from '../stores/canvasStore'
import { useUIStore } from '../stores/uiStore'
import { listLayouts, loadLayoutIntoCanvas } from '../lib/layouts'
import { CARD_SURFACE } from '../ui/Modal'
import { Tooltip } from '../ui/Tooltip'
import log from '../lib/logger'

export function EmptyCanvasOverlay({
  workspaceId,
  panelId,
  canvasApi,
}: {
  workspaceId: string
  panelId: string
  canvasApi: StoreApi<CanvasStore>
}) {
  const layoutsVersion = useUIStore((s) => s.layoutsVersion)
  const setShowLayoutsDialog = useUIStore((s) => s.setShowLayoutsDialog)
  const [names, setNames] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    listLayouts().then(setNames).catch((err) => log.warn('[EmptyCanvasOverlay] list failed', err))
  }, [layoutsVersion])

  const load = useCallback(async (name: string) => {
    setBusy(true)
    try {
      await loadLayoutIntoCanvas(name, workspaceId, panelId, canvasApi)
    } finally {
      setBusy(false)
    }
  }, [workspaceId, panelId, canvasApi])

  const visible = !dismissed && names.length > 0

  // Escape dismisses the overlay (continue with a blank canvas).
  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(true) }
    }
    document.addEventListener('keydown', handler, { capture: true })
    return () => document.removeEventListener('keydown', handler, { capture: true })
  }, [visible])

  if (!visible) return null

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
      <div className={`pointer-events-auto w-[360px] max-w-[90%] overflow-hidden ${CARD_SURFACE}`}>
        <div className="flex items-center justify-between pl-3.5 pr-2 pt-2 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            Start from a layout
          </span>
          <Tooltip label="Close (Esc)">
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="flex items-center justify-center w-5 h-5 rounded text-muted hover:text-secondary hover:bg-white/5"
              aria-label="Close"
            >
              <X size={13} />
            </button>
          </Tooltip>
        </div>
        <div className="pb-1.5 max-h-[260px] overflow-y-auto">
          {names.map((name) => (
            <button
              key={name}
              type="button"
              disabled={busy}
              onClick={() => load(name)}
              className="w-full flex items-center gap-2.5 px-3.5 py-1.5 text-left hover:bg-[rgb(var(--agent-rgb))]/12 disabled:opacity-50"
            >
              <span className="shrink-0 text-violet-400"><SquaresFour size={16} /></span>
              <span className="flex-1 text-primary text-[13px] truncate">{name}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-subtle">
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="px-3.5 py-2 text-left text-[11px] text-muted hover:text-secondary"
          >
            Continue without layout
          </button>
          <button
            type="button"
            onClick={() => setShowLayoutsDialog(true)}
            className="px-3.5 py-2 text-right text-[11px] text-muted hover:text-secondary"
          >
            Manage…
          </button>
        </div>
      </div>
    </div>
  )
}
