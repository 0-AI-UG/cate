// When a panel's agent goes back to work, what it asked for is answered: a
// shell withdraws the notification it showed for it (architecture 10.5).

import { acquireAgentPanels } from './panelStates'

export interface AgentConnections {
  getSnapshot(): readonly { readonly workspaceId: string }[]
  subscribe(listener: () => void): () => void
}

/** Calls `working` for every running agent panel of every open workspace,
 *  whenever the agent states change. */
export function onAgentsWorking(connections: AgentConnections, working: (workspaceId: string, panelId: string) => void): () => void {
  const attached = new Map<string, () => void>()
  const attachOne = (workspaceId: string) => {
    const panels = acquireAgentPanels(workspaceId)
    const off = panels.subscribe(() => {
      for (const [panelId, state] of Object.entries(panels.getSnapshot())) {
        if (state.status === 'running') working(workspaceId, panelId)
      }
    })
    return () => {
      off()
      panels.release()
    }
  }
  const sync = () => {
    const current = new Set(connections.getSnapshot().map((connection) => connection.workspaceId))
    for (const [workspaceId, detach] of attached) {
      if (current.has(workspaceId)) continue
      attached.delete(workspaceId)
      detach()
    }
    for (const workspaceId of current) {
      if (!attached.has(workspaceId)) attached.set(workspaceId, attachOne(workspaceId))
    }
  }
  const stop = connections.subscribe(sync)
  sync()
  return () => {
    stop()
    for (const detach of attached.values()) detach()
    attached.clear()
  }
}
