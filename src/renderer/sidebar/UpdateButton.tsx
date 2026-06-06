// =============================================================================
// UpdateButton — a small, fixed-size circular button pinned to the bottom of the
// right sidebar's activity bar. The circle never changes size; only its contents
// adapt to the update state so the user always sees the relevant affordance:
//   • available   → up arrow (click to download)
//   • downloading → progress ring + percent (non-interactive)
//   • downloaded  → restart glyph (click to restart & install)
//   • manual      → open-release glyph
// Restart is user-initiated; we never auto-quit the app from here.
// =============================================================================

import React from 'react'
import { ArrowUp, ArrowClockwise, ArrowSquareOut } from '@phosphor-icons/react'
import { useUpdateStore } from '../stores/updateStore'

const SIZE = 32 // px — fixed, matches the activity-bar icon footprint
const R = 13.5 // progress-ring radius (within the SIZE box)
const STROKE = 2.5
const CIRC = 2 * Math.PI * R

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
      : 0

  // Beta / staged build — only ever shown to opted-in testers (Settings → Updates).
  const isBeta = status.prerelease === true

  const baseTitle =
    status.state === 'downloading'
      ? typeof status.percent === 'number'
        ? `Downloading update… ${Math.round(status.percent)}%`
        : 'Downloading update…'
      : status.state === 'downloaded'
        ? 'Click to restart and install the update'
        : status.state === 'manual'
          ? 'Open release page to download manually'
          : 'Update available. Click to download.'
  const title = isBeta ? `${`Beta build ${status.version || ''}`.trim()}. ${baseTitle}` : baseTitle

  const isDownloading = status.state === 'downloading'

  const onAction = () => {
    if (status.state === 'available') {
      window.electronAPI.updateDownload()
    } else if (status.state === 'downloaded') {
      window.electronAPI.updateInstall()
    } else if (status.state === 'manual') {
      window.electronAPI.updateOpenRelease(status.releaseUrl)
    }
    // 'downloading' → no-op; button is non-interactive while progress fills.
  }

  return (
    <button
      type="button"
      onClick={onAction}
      disabled={isDownloading}
      title={title}
      aria-label={title}
      style={{ width: SIZE, height: SIZE, WebkitTapHighlightColor: 'transparent' }}
      className="group relative flex shrink-0 items-center justify-center rounded-full bg-[var(--focus-blue,#3b82f6)] text-white shadow-sm hover:brightness-110 active:scale-95 disabled:active:scale-100 focus:outline-none transition-[filter,transform]"
    >
      {/* Progress ring — sits flush inside the circle while downloading. */}
      {isDownloading && (
        <svg
          aria-hidden
          className="absolute inset-0 -rotate-90"
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
        >
          <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth={STROKE} />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            stroke="white"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - percent / 100)}
            style={{ transition: 'stroke-dashoffset 200ms ease-out' }}
          />
        </svg>
      )}

      {/* State glyph — always centred, never resizing the circle. */}
      {isDownloading ? (
        <span className="text-[8px] font-bold leading-none tabular-nums">
          {typeof status.percent === 'number' ? Math.round(status.percent) : '…'}
        </span>
      ) : status.state === 'downloaded' ? (
        <ArrowClockwise size={16} weight="bold" />
      ) : status.state === 'manual' ? (
        <ArrowSquareOut size={15} weight="bold" />
      ) : (
        <ArrowUp size={17} weight="bold" />
      )}

      {/* Beta marker — tiny amber dot at the corner. */}
      {isBeta && (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-300 ring-2 ring-[var(--surface-0)]"
        />
      )}
    </button>
  )
}
