// A terminal's tab menu: "Fit Terminal to Panel" and "Reset Terminal
// Rendering". The mounted views of
// this client, so the menu reaches the view of the chosen panel.

import type { TabMenuContribution } from '../../client/layout/dock'

export interface MountedTerminal {
  fit(): void
  resetRendering(): void
}

const mounted = new Map<string, MountedTerminal>()
const keyOf = (workspaceId: string, panelId: string) => `${workspaceId}:${panelId}`

export function registerTerminalView(workspaceId: string, panelId: string, view: MountedTerminal): () => void {
  const key = keyOf(workspaceId, panelId)
  mounted.set(key, view)
  return () => { if (mounted.get(key) === view) mounted.delete(key) }
}

export const terminalTabMenu: TabMenuContribution = {
  items: ({ record }) => (record.type === 'terminal'
    ? [
        { id: 'fit-terminal', label: 'Fit Terminal to Panel' },
        { id: 'reset-terminal-rendering', label: 'Reset Terminal Rendering' },
      ]
    : []),
  run(id, { workspaceId, record }) {
    const view = mounted.get(keyOf(workspaceId, record.id))
    if (id === 'fit-terminal') view?.fit()
    else if (id === 'reset-terminal-rendering') view?.resetRendering()
    else return false
    return true
  },
}
