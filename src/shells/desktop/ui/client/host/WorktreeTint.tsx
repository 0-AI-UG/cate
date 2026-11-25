// The worktree tint of a panel whose type switches worktrees: a faint wash of
// its worktree's color over the view, also while its picker menu previews
// another worktree. None with a single worktree or with the setting off.

import { useMemo, useSyncExternalStore } from 'react'
import { panelCheckout } from '@workspace/repository/contract'
import type { PanelRecord } from '@workspace/document/contract'
import { panelCheckoutHooks } from '@client/host'
import { useDocument } from '../document'
import { useCanvasUi, worktreeColor } from '../layout/canvas'
import { getActiveTheme, subscribeTheme } from '../../kernel/interaction'
import { useClientSetting } from '../../kernel/settings'

export function WorktreeTint({ workspaceId, record }: { workspaceId: string; record: PanelRecord }) {
  const enabled = useClientSetting('worktreeTint')
  const theme = useSyncExternalStore(subscribeTheme, getActiveTheme)
  const worktrees = useDocument(workspaceId, (d) => d.worktrees)
  const preview = useCanvasUi((s) => (s.previewWorktree?.panelId === record.id ? s.previewWorktree.worktreeId : null))
  const color = useMemo(() => {
    const ready = Object.values(worktrees).filter((w) => w.status === 'ready')
    if (ready.length < 2) return null
    const shown = (preview ? ready.find((w) => w.id === preview) : undefined) ?? panelCheckout(record, ready, panelCheckoutHooks)
    return shown ? worktreeColor(shown.color, theme) : null
  }, [record, worktrees, preview, theme])
  return <div aria-hidden className="pointer-events-none absolute inset-0 z-[1] transition-colors duration-150"
    style={{ backgroundColor: enabled && color ? `color-mix(in srgb, ${color} 7%, transparent)` : 'transparent' }} />
}
