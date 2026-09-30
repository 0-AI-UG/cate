// "Reset Terminal Rendering" in a terminal's tab menu: the mounted views of
// this client, so the menu reaches the xterm of the chosen panel.

import type { TabMenuContribution } from '@client/layout/dock'
import type { TerminalXterm } from '../parts/view/xterm'

const mounted = new Map<string, TerminalXterm>()
const keyOf = (workspaceId: string, panelId: string) => `${workspaceId}:${panelId}`

export function registerTerminalXterm(workspaceId: string, panelId: string, xterm: TerminalXterm): () => void {
  const key = keyOf(workspaceId, panelId)
  mounted.set(key, xterm)
  return () => { if (mounted.get(key) === xterm) mounted.delete(key) }
}

export const terminalTabMenu: TabMenuContribution = {
  items: ({ record }) => (record.type === 'terminal' ? [{ id: 'reset-terminal-rendering', label: 'Reset Terminal Rendering' }] : []),
  run(id, { workspaceId, record }) {
    if (id !== 'reset-terminal-rendering') return false
    mounted.get(keyOf(workspaceId, record.id))?.resetRendering()
    return true
  },
}
