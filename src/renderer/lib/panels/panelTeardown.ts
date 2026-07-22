// =============================================================================
// teardownPanelContent — THE single decision point for what happens to a
// panel's window-local content (PTY, xterm, pi session) when the panel leaves
// this window:
//   'close'    → the panel is gone for good: kill the PTY, dispose the xterm.
//   'transfer' → the panel moves to another window: release the xterm but KEEP
//                the PTY running (ownership migrates via the main process).
// The dispose-vs-release choice is the difference between "terminal survives
// the move" and "user's process is killed" — never pick it at a call site.
//
// Cate Agent chats are workspace-owned and outlive panels. Their headless
// sessions are owned by cateAgentController, so a panel has no local agent
// process to dispose or transfer.
// =============================================================================

import type { PanelType } from '../../../shared/types'
import { terminalRegistry } from '../terminal/terminalRegistry'

export type PanelRemovalReason = 'close' | 'transfer'

/** Tear down a panel's window-local content per `reason`. Safe for any panel
 *  type: the terminal registry calls are no-ops for non-terminal ids, so a
 *  missing/unknown `panelType` (stale record) still cleans up correctly. */
export function teardownPanelContent(
  panelId: string,
  panelType: PanelType | undefined,
  reason: PanelRemovalReason,
): void {
  if (reason === 'close') {
    terminalRegistry.dispose(panelId)
  } else {
    terminalRegistry.release(panelId)
  }
}
