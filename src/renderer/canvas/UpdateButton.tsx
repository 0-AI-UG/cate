// =============================================================================
// UpdateButton — single blue pill in the bottom-right toolbar.
// Click to download → progress fills inside the pill → click again to restart.
// Restart is user-initiated; we never auto-quit the app from here.
// =============================================================================

import React from 'react'
import { ArrowCircleUp } from '@phosphor-icons/react'
import { useUpdateStore } from '../stores/updateStore'

export const UpdateButton: React.FC = () => {
  const status = useUpdateStore((s) => s.status)

  // Only render for states with an actionable update.
  if (
    status.state !== 'available' &&
    status.state !== 'downloading' &&
    status.state !== 'downloaded' &&
    status.state !== 'manual'
  ) {
    return null
  }

  const percent =
    status.state === 'downloading' && typeof status.percent === 'number'
      ? Math.max(0, Math.min(100, status.percent))
      : status.state === 'downloaded'
        ? 100
        : 0

  const label =
    status.state === 'downloading'
      ? typeof status.percent === 'number'
        ? `${Math.round(status.percent)}%`
        : '…'
      : status.state === 'downloaded'
        ? 'Restart'
        : 'Update'

  // Beta / staged build — surfaced only to users who opted into the beta channel
  // in Settings → Updates. Stable users never receive a pre-release, so this
  // chip only ever shows for opted-in testers.
  const isBeta = status.prerelease === true

  const baseTitle =
    status.state === 'downloading'
      ? 'Downloading update…'
      : status.state === 'downloaded'
        ? 'Click to restart and install the update'
        : status.state === 'manual'
          ? 'Open release page to download manually'
          : 'Click to download the update'
  const title = isBeta ? `Beta build ${status.version || ''} — ${baseTitle}`.trim() : baseTitle

  const onClick = () => {
    if (status.state === 'available') {
      window.electronAPI.updateDownload()
    } else if (status.state === 'downloaded') {
      window.electronAPI.updateInstall()
    } else if (status.state === 'manual') {
      window.electronAPI.updateOpenRelease(status.releaseUrl)
    }
    // 'downloading' → no-op; button is non-interactive while progress fills.
  }

  const isDownloading = status.state === 'downloading'
  const showFill = isDownloading || status.state === 'downloaded'

  return (
    <span className="flex items-center gap-1.5">
      {/* Beta tag — marks a staged / pre-release build so an opted-in tester can
          tell it apart from a stable update at a glance. */}
      {isBeta && (
        <span
          title={title}
          className="select-none rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500 ring-1 ring-amber-500/30"
        >
          Beta
        </span>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={isDownloading}
        title={title}
        style={{ WebkitTapHighlightColor: 'transparent' }}
        className="group relative overflow-hidden flex items-center justify-center gap-1 h-[28px] w-[76px] rounded-full bg-[var(--focus-blue,#3b82f6)] text-white text-[11px] font-medium shadow-[0_0_24px_-2px_rgba(59,130,246,0.7),0_8px_24px_-6px_rgba(59,130,246,0.55)] hover:brightness-110 active:scale-[0.97] disabled:active:scale-100 focus:outline-none transition-all"
      >
        {/* Progress fill — lighter blue overlay that grows left-to-right while downloading. */}
        {showFill && (
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 bg-white/25 transition-[width] duration-200 ease-out pointer-events-none"
            style={{ width: `${percent}%` }}
          />
        )}
        <ArrowCircleUp size={12} weight="fill" className="relative z-[1]" />
        <span className="relative z-[1] whitespace-nowrap">{label}</span>
      </button>
    </span>
  )
}
