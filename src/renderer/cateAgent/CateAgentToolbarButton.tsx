// =============================================================================
// CateAgentToolbarButton — the Cate Agent's entry point, docked as the leftmost
// item of the canvas toolbar. Color reflects activity (off/resting gray,
// observing blue, working green); clicking it toggles the toolbar's prompt input.
// =============================================================================

import React from 'react'
import { CateLogo } from '../ui/CateLogo'
import { Tooltip } from '../ui/Tooltip'
import type { CateAgentActivity } from '../../shared/types'

const COLOR: Record<CateAgentActivity, string> = {
  off: 'var(--surface-5)',
  resting: 'var(--surface-5)',
  observing: '#60a5fa',
  working: '#4ade80',
}

export const CateAgentToolbarButton: React.FC<{
  activity: CateAgentActivity
  active: boolean
  /** Unseen agent activity while the panel is closed → pulse + notification dot. */
  attention: boolean
  onClick: () => void
}> = ({ activity, active, attention, onClick }) => {
  const color = COLOR[activity] ?? COLOR.resting
  const busy = activity === 'working' || activity === 'observing'
  return (
    <Tooltip label={attention ? 'Cate Agent — new activity' : 'Cate Agent — ask it to do something'} placement="top">
      <button
        type="button"
        onClick={onClick}
        aria-label="Cate Agent"
        aria-pressed={active}
        style={{
          WebkitTapHighlightColor: 'transparent',
          // The attention animation supplies its own box-shadow; otherwise show
          // the static activity ring.
          boxShadow: attention ? undefined : `0 0 0 2px color-mix(in srgb, ${color} ${busy ? 70 : 50}%, transparent)`,
        }}
        className={`relative w-9 h-9 flex items-center justify-center rounded-full transition-all duration-100 active:scale-[0.92] ${
          active ? 'bg-hover-strong' : 'bg-transparent hover:bg-hover-strong'
        } ${attention ? 'cate-agent-attention' : ''}`}
      >
        <CateLogo size={20} />
        {attention && (
          <span
            aria-hidden
            className="absolute -top-0.5 right-0.5 w-2 h-2 rounded-full ring-2 ring-surface-0"
            style={{ backgroundColor: 'rgb(var(--agent-rgb))' }}
          />
        )}
      </button>
    </Tooltip>
  )
}
