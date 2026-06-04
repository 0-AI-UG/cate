// =============================================================================
// confirmCloseRunningTerminals — shared helper that prompts the user via the
// native dialog when closing terminal panels whose PTY is currently running a
// foreground process (a dev server, an editor, an agent like Claude / Codex, …).
// Mirrors confirmCloseDirtyPanels for editors. Returns true if the close should
// proceed.
// =============================================================================

import type { PanelState } from '../../shared/types'
import { terminalRegistry } from './terminal/terminalRegistry'
import { useStatusStore } from '../stores/statusStore'

interface RunningTerminal {
  panelId: string
  processName: string | null
}

/** Inspect a set of panels and return those terminal panels whose PTY currently
 *  has a running foreground process, per the main-process activity scan. An idle
 *  shell reports `{ type: 'idle' }`, so plain shells never trigger a prompt. */
function findRunningTerminals(panels: Array<PanelState | undefined>): RunningTerminal[] {
  const status = useStatusStore.getState()
  const out: RunningTerminal[] = []
  for (const p of panels) {
    if (!p || p.type !== 'terminal') continue
    // terminalActivity is keyed by ptyId; map panelId → ptyId via the registry.
    const ptyId = terminalRegistry.getEntry(p.id)?.ptyId
    if (!ptyId) continue
    const wsId = status.terminalWorkspaceMap[ptyId]
    if (!wsId) continue
    const activity = status.workspaces[wsId]?.terminalActivity[ptyId]
    if (activity?.type === 'running') {
      out.push({ panelId: p.id, processName: activity.processName })
    }
  }
  return out
}

export async function confirmCloseRunningTerminals(
  panels: Array<PanelState | undefined>,
): Promise<boolean> {
  const running = findRunningTerminals(panels)
  if (running.length === 0) return true
  if (!window.electronAPI?.confirmCloseTerminal) return true

  const processName = running.length === 1 ? running[0].processName : null

  const choice = await window.electronAPI.confirmCloseTerminal({
    count: running.length,
    processName,
  })
  return choice === 'close'
}
