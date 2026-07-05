// =============================================================================
// ExtensionToolbarMenu — the canvas toolbar's entry point for opening extension
// panels. It only renders when at least one enabled extension exposes a panel.
//
//   - exactly one openable panel  → the button opens it directly.
//   - more than one               → the button opens a drop-up to pick.
//
// Opening an extension is the only place panels are launched from; the settings
// screen manages install/enable state, not windows.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SquaresFour } from '@phosphor-icons/react'
import { Tooltip } from '../ui/Tooltip'
import { useAppStore } from '../stores/appStore'
import {
  ensureExtensionsStarted,
  enabledPanelTargets,
  useExtensionsStore,
  type ExtensionPanelTarget,
} from '../stores/extensionsStore'

interface ExtensionToolbarMenuProps {
  canvasPanelId: string
  workspaceId: string
}

const ExtensionToolbarMenu: React.FC<ExtensionToolbarMenuProps> = ({ canvasPanelId, workspaceId }) => {
  const entries = useExtensionsStore((s) => s.entries)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    ensureExtensionsStarted()
  }, [])

  const targets = enabledPanelTargets(entries)

  const openTarget = useCallback(
    (t: ExtensionPanelTarget) => {
      useAppStore
        .getState()
        .createExtensionPanel(
          workspaceId,
          t.extensionId,
          t.panelId,
          undefined,
          { target: 'canvas', canvasPanelId },
          t.panelLabel,
        )
      setOpen(false)
    },
    [workspaceId, canvasPanelId],
  )

  const onClick = useCallback(() => {
    if (targets.length === 1) {
      openTarget(targets[0])
      return
    }
    if (open) {
      setOpen(false)
      return
    }
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      // Center the popover over the button, clamped to the viewport.
      const width = 240
      const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8))
      setPos({ left, bottom: window.innerHeight - r.top + 10 })
    }
    setOpen(true)
  }, [targets, open, openTarget])

  // Nothing enabled exposes a panel — no button.
  if (targets.length === 0) return null

  const active = open
  const title = targets.length === 1 ? `Open ${targets[0].extensionName}` : 'Extensions'

  return (
    <>
      <Tooltip label={title} placement="top">
        <button
          ref={btnRef}
          type="button"
          onClick={onClick}
          aria-label="Extensions"
          style={{ WebkitTapHighlightColor: 'transparent' }}
          className={`w-9 h-9 ${active ? 'bg-hover-strong text-primary' : 'bg-transparent text-secondary'} flex items-center justify-center rounded-full hover:text-primary hover:bg-hover-strong active:bg-hover-strong active:scale-[0.92] focus:outline-none focus-visible:outline-none transition-all duration-100`}
        >
          <SquaresFour size={18} />
        </button>
      </Tooltip>
      {open && pos &&
        createPortal(
          <ExtensionMenuPopover
            pos={pos}
            triggerRef={btnRef}
            targets={targets}
            onPick={openTarget}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </>
  )
}

const ExtensionMenuPopover: React.FC<{
  pos: { left: number; bottom: number }
  triggerRef: React.RefObject<HTMLButtonElement>
  targets: ExtensionPanelTarget[]
  onPick: (t: ExtensionPanelTarget) => void
  onClose: () => void
}> = ({ pos, triggerRef, targets, onPick, onClose }) => {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (rootRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, triggerRef])

  // Group panels under their extension so a multi-panel extension reads clearly.
  const byExt = new Map<string, ExtensionPanelTarget[]>()
  for (const t of targets) {
    const list = byExt.get(t.extensionId) ?? []
    list.push(t)
    byExt.set(t.extensionId, list)
  }

  return (
    <div
      ref={rootRef}
      className="fixed z-[1000] w-[240px] rounded-2xl border border-subtle shadow-xl py-1.5 text-xs"
      style={{
        left: pos.left,
        bottom: pos.bottom,
        background: 'color-mix(in srgb, var(--surface-0) 80%, transparent)',
        backdropFilter: 'blur(24px) saturate(1.5)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.5)',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {Array.from(byExt.values()).map((panels) => (
        <div key={panels[0].extensionId}>
          {/* One header per extension, always — its panels list beneath it. */}
          <div className="px-2.5 pt-1 pb-0.5 text-[10px] font-medium text-muted truncate select-none">
            {panels[0].extensionName}
          </div>
          {panels.map((t) => (
            <button
              key={`${t.extensionId}:${t.panelId}`}
              onClick={() => onPick(t)}
              className="mx-1 w-[calc(100%-0.5rem)] flex items-center gap-2 h-[28px] px-1.5 rounded-lg text-[12px] text-secondary hover:text-primary hover:bg-surface-4 transition-colors"
            >
              <span className="flex-1 min-w-0 truncate text-left">{t.panelLabel}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

export default ExtensionToolbarMenu
