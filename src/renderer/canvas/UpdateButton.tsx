// =============================================================================
// UpdateButton — subtle blue pill in the bottom-right toolbar, shown only
// when the auto-updater has a new release available. Replaces the native OS
// popup with an in-app affordance + small popover.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react'
import { ArrowCircleUp, X } from '@phosphor-icons/react'
import { useUpdateStore } from '../stores/updateStore'

export const UpdateButton: React.FC = () => {
  const status = useUpdateStore((s) => s.status)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Only render for states that have an actionable update to offer.
  if (
    status.state !== 'available' &&
    status.state !== 'downloading' &&
    status.state !== 'downloaded' &&
    status.state !== 'manual'
  ) {
    return null
  }

  const label =
    status.state === 'downloading'
      ? typeof status.percent === 'number'
        ? `Updating… ${Math.round(status.percent)}%`
        : 'Updating…'
      : status.state === 'downloaded'
        ? 'Restart to update'
        : status.state === 'manual'
          ? `Update v${status.version}`
          : `Update v${status.version}`

  const title =
    status.state === 'downloading'
      ? 'Downloading update'
      : status.state === 'downloaded'
        ? 'Update ready — click to restart and install'
        : status.state === 'manual'
          ? 'Open release page to download manually'
          : 'A new version of Cate is available'

  const onPrimary = () => {
    if (status.state === 'available') {
      window.electronAPI.updateDownload()
    } else if (status.state === 'downloaded') {
      window.electronAPI.updateInstall()
    } else if (status.state === 'manual') {
      window.electronAPI.updateOpenRelease(status.releaseUrl)
    }
  }

  const primaryLabel =
    status.state === 'available'
      ? 'Download'
      : status.state === 'downloading'
        ? 'Downloading…'
        : status.state === 'downloaded'
          ? 'Restart & Install'
          : 'Open Release Page'

  return (
    <div ref={wrapRef} className="relative">
      {/* Popover */}
      {open && (
        <div
          data-theme="dark-warm"
          className="absolute right-0 bottom-full mb-2 w-[260px] rounded-lg border border-subtle bg-surface-4/95 backdrop-blur-xl backdrop-saturate-150 shadow-[0_18px_40px_-12px_var(--shadow-node)] p-3"
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <div>
              <div className="text-[13px] font-semibold text-primary">
                {status.state === 'downloaded'
                  ? 'Update ready'
                  : status.state === 'manual'
                    ? 'Update available'
                    : status.state === 'downloading'
                      ? 'Downloading update'
                      : 'Update available'}
              </div>
              {('version' in status) && status.version && (
                <div className="text-[11px] text-secondary mt-0.5">Cate v{status.version}</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                window.electronAPI.updateDismiss()
              }}
              title="Dismiss"
              className="w-5 h-5 flex items-center justify-center rounded text-secondary hover:bg-hover-strong focus:outline-none"
            >
              <X size={12} />
            </button>
          </div>
          <div className="text-[12px] text-secondary leading-snug mb-3">
            {status.state === 'downloaded'
              ? 'The new version has been downloaded. Restart Cate to apply.'
              : status.state === 'manual'
                ? 'Automatic installation is unavailable in this build. Open the release page to download manually.'
                : status.state === 'downloading'
                  ? 'Download in progress. You can keep working — Cate will prompt to restart when ready.'
                  : 'A new version of Cate is ready to install.'}
          </div>
          {status.state === 'downloading' && typeof status.percent === 'number' && (
            <div className="h-1 rounded-full bg-surface-5 overflow-hidden mb-3">
              <div
                className="h-full bg-[var(--focus-blue,#3b82f6)] transition-[width] duration-200"
                style={{ width: `${Math.max(2, Math.min(100, status.percent))}%` }}
              />
            </div>
          )}
          <button
            type="button"
            onClick={onPrimary}
            disabled={status.state === 'downloading'}
            className="w-full px-3 py-1.5 rounded-md bg-[var(--focus-blue,#3b82f6)] text-white text-[12px] font-medium hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none transition-all"
          >
            {primaryLabel}
          </button>
        </div>
      )}

      {/* Pill button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        style={{ WebkitTapHighlightColor: 'transparent' }}
        className="group flex items-center gap-1.5 h-[34px] pl-2.5 pr-3 rounded-full border border-[var(--focus-blue,#3b82f6)]/40 bg-[var(--focus-blue,#3b82f6)] text-white text-[11px] font-medium shadow-[0_8px_24px_-6px_rgba(59,130,246,0.55)] hover:brightness-110 active:scale-[0.97] focus:outline-none transition-all"
      >
        <ArrowCircleUp size={14} weight="fill" />
        <span className="whitespace-nowrap">{label}</span>
      </button>
    </div>
  )
}
