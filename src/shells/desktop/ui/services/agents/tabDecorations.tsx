// What agents add to dock tabs and panel chrome, registered into the dock's
// slots by the workspace views: a detected agent's logo and name, its status
// mark, and the agent changes pill.

import type { ReactNode } from 'react'
import type { PanelRecord } from '@workspace/document/contract'
import { AgentChangesPill } from './AgentChangesPill'
import { AwaitingIndicator, RunningIndicator } from './indicators'
import { agentInfoTitle } from './panelInfo'
import { useAgentInfoByPanel } from './useAgentPanels'

/** Agent status on tabs: logo, running ring or awaiting-input dot, title. */
export function useAgentTabDecorations(workspaceId: string): Record<string, {
  logo: string | null
  logoAlt: string | null
  status: ReactNode
  retitle: (title: string) => string
}> {
  const info = useAgentInfoByPanel(workspaceId)
  const out: ReturnType<typeof useAgentTabDecorations> = {}
  for (const [panelId, agent] of Object.entries(info)) {
    out[panelId] = {
      logo: agent.runner === 'terminal' ? agent.logo : null,
      logoAlt: agent.name,
      status: agent.status === 'waitingForInput'
        ? <AwaitingIndicator />
        : agent.status === 'running' ? <RunningIndicator /> : null,
      retitle: (title) => agentInfoTitle(title, agent),
    }
  }
  return out
}

/** The agent changes pill over a panel's top-right corner. */
export function AgentChangesOverlay({ workspaceId, record }: { workspaceId: string; record: PanelRecord }) {
  return <AgentChangesPill key={`changes:${record.id}`} workspaceId={workspaceId} panelId={record.id} />
}
