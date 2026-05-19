// =============================================================================
// UpdateButton — single blue pill in the bottom-right toolbar.
// Click to download → progress fills inside the pill → auto-restart to install.
// No popover; the button itself is the affordance.
// =============================================================================

import React, { useEffect, useRef } from 'react'
import { ArrowCircleUp } from '@phosphor-icons/react'
import { useUpdateStore } from '../stores/updateStore'

export const UpdateButton: React.FC = () => {
  const status = useUpdateStore((s) => s.status)
  // Guard so the auto-install transition fires exactly once per "downloaded" event.
  const installedRef = useRef(false)

  // When the download completes, trigger restart-to-install automatically.
  useEffect(() => {
    if (status.state === 'downloaded' && !installedRef.current) {
      installedRef.current = true
      // Small delay lets the user see the "Restarting…" label flash before quit.
      const t = setTimeout(() => window.electronAPI.updateInstall(), 600)
      return () => clearTimeout(t)
    }
    if (status.state !== 'downloaded' && status.state !== 'downloading') {
      installedRef.current = false
    }
  }, [status.state])

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
        ? `Updating… ${Math.round(status.percent)}%`
        : 'Updating…'
      : status.state === 'downloaded'
        ? 'Restarting…'
        : status.state === 'manual'
          ? `Update v${status.version}`
          : `Update v${status.version}`

  const title =
    status.state === 'downloading'
      ? 'Downloading update'
      : status.state === 'downloaded'
        ? 'Restarting to install update…'
        : status.state === 'manual'
          ? 'Open release page to download manually'
          : 'Click to download and install update'

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

  const isProgressing = status.state === 'downloading' || status.state === 'downloaded'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isProgressing}
      title={title}
      style={{ WebkitTapHighlightColor: 'transparent' }}
      className="group relative overflow-hidden flex items-center gap-1.5 h-[34px] pl-2.5 pr-3 rounded-full bg-[var(--focus-blue,#3b82f6)] text-white text-[11px] font-medium shadow-[0_0_24px_-2px_rgba(59,130,246,0.7),0_8px_24px_-6px_rgba(59,130,246,0.55)] hover:brightness-110 active:scale-[0.97] disabled:active:scale-100 focus:outline-none transition-all"
    >
      {/* Progress fill — lighter blue overlay that grows left-to-right while downloading. */}
      {isProgressing && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-white/25 transition-[width] duration-200 ease-out pointer-events-none"
          style={{ width: `${percent}%` }}
        />
      )}
      <ArrowCircleUp size={14} weight="fill" className="relative z-[1]" />
      <span className="relative z-[1] whitespace-nowrap">{label}</span>
    </button>
  )
}
