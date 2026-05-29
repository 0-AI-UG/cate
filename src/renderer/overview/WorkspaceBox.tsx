// =============================================================================
// WorkspaceBox — one workspace section in the Overview overlay: a label plus a
// tinted box (workspace color) holding all of that workspace's windows tiled at
// uniform size. Clicking the box background (not a card) switches workspaces.
// =============================================================================

import React, { useCallback } from 'react'
import OverviewCard, { CARD_W, CARD_H, CARD_GAP } from './OverviewCard'
import { navigateToWorkspace } from './navigate'
import type { OverviewWorkspace } from './collectOverview'

const BOX_PADDING = 16
const MAX_COLUMNS = 4

const WorkspaceBox: React.FC<{ workspace: OverviewWorkspace }> = ({ workspace }) => {
  const { name, color, windows, deferred } = workspace

  const columns = Math.max(1, Math.min(windows.length || 1, MAX_COLUMNS))
  const boxWidth = columns * CARD_W + (columns - 1) * CARD_GAP + BOX_PADDING * 2

  const handleClick = useCallback(() => {
    void navigateToWorkspace(workspace.id)
  }, [workspace.id])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-secondary">
        <span>{name}</span>
        {deferred && <span className="text-[10px] text-muted font-normal">(nicht geladen)</span>}
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        title={`Zu ${name} wechseln`}
        className="rounded-xl border border-white/10 cursor-pointer transition-colors hover:border-white/25"
        style={{
          width: boxWidth,
          padding: BOX_PADDING,
          backgroundColor: `color-mix(in srgb, ${color} 14%, var(--surface-1))`,
        }}
      >
        {windows.length === 0 ? (
          <div
            className="flex items-center justify-center text-xs text-muted"
            style={{ height: CARD_H }}
          >
            Keine Fenster
          </div>
        ) : (
          <div
            className="grid"
            style={{
              gridTemplateColumns: `repeat(${columns}, ${CARD_W}px)`,
              gap: CARD_GAP,
            }}
          >
            {windows.map((win) => (
              <OverviewCard key={`${win.workspaceId}:${win.nodeId ?? win.panelId}`} win={win} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default WorkspaceBox
