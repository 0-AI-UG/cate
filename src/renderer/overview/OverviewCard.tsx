// =============================================================================
// OverviewCard — one schematic window card in the Overview overlay. Title bar
// (icon + title), big centered type logo, and a short snippet. No live panel
// content (that is Phase 2, on zoom-in).
// =============================================================================

import React, { useCallback } from 'react'
import { getPanelDef } from '../panels/registry'
import { navigateToNode } from './navigate'
import type { OverviewWindow } from './collectOverview'

/** Fixed card geometry — shared with WorkspaceBox/OverviewMode for layout math. */
export const CARD_W = 220
export const CARD_H = 140
export const CARD_GAP = 16

const OverviewCard: React.FC<{ win: OverviewWindow }> = ({ win }) => {
  const def = getPanelDef(win.panelType)
  const Icon = def.icon
  const color = def.brandColor
  // Agent brand logo (Claude Code / Codex / …) for terminals running a
  // detected agent; resolved in collectOverview from live status + title.
  const agentLogo = win.logo

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation() // don't trigger the workspace-box click
      void navigateToNode(win.workspaceId, win.nodeId)
    },
    [win.workspaceId, win.nodeId],
  )

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      title={win.title}
      className="flex flex-col rounded-lg overflow-hidden bg-surface-3 border border-white/10 shadow-sm cursor-pointer transition-transform hover:scale-[1.02] hover:border-white/25"
      style={{ width: CARD_W, height: CARD_H }}
    >
      {/* Title bar */}
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-primary"
        style={{ backgroundColor: `color-mix(in srgb, ${color} 22%, transparent)` }}
      >
        {agentLogo ? (
          <img
            src={agentLogo}
            alt={win.title}
            width={14}
            height={14}
            style={{ objectFit: 'contain', display: 'block' }}
            draggable={false}
            className="flex-shrink-0"
          />
        ) : (
          <Icon size={13} weight="bold" style={{ color }} className="flex-shrink-0" />
        )}
        <span className="truncate">{win.title}</span>
      </div>

      {/* Body: big agent logo (terminals) or type logo + optional snippet */}
      <div className="relative flex-1 flex flex-col items-center justify-center gap-1.5 min-h-0">
        {agentLogo ? (
          <img
            src={agentLogo}
            alt={win.title}
            width={40}
            height={40}
            style={{ objectFit: 'contain', display: 'block' }}
            draggable={false}
          />
        ) : (
          <Icon size={40} weight="duotone" style={{ color, opacity: 0.55 }} />
        )}
        {win.snippet && (
          <span className="px-2 max-w-full truncate text-[11px] text-muted">{win.snippet}</span>
        )}
      </div>
    </div>
  )
}

export default OverviewCard
