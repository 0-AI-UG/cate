// What agents add to dock tabs and panel chrome, registered into the dock's
// slots by the workspace views: a detected agent's logo and name, its status
// mark, the agent changes pill and the hooks-off warning.

import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { clientUi } from '@kernel/interaction'
import type { PanelRecord } from '@workspace/document/contract'
import { AgentChangesPill } from './AgentChangesPill'
import { AwaitingIndicator, RunningIndicator } from './indicators'
import { agentInfoTitle } from './panelInfo'
import { useAgentInfoByPanel, useAgentPanelState } from './useAgentPanels'

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
      logo: agent.takesOverPanel ? agent.logo : null,
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

/** A warning over a panel's top-right corner while its agent runs without
 *  Cate's hooks; opens the agent hooks settings. */
export function AgentHooksOffOverlay({ workspaceId, record }: { workspaceId: string; record: PanelRecord }) {
  const state = useAgentPanelState(workspaceId, record.id)
  if (!state?.hooksMissing) return null
  return (
    <button type="button" title={`${state.agentName ?? 'This agent'} runs without Cate hooks, so its status and connected panels do not reach Cate`}
      className="inline-flex h-[18px] items-center gap-1 rounded-full bg-surface-3 px-1.5 text-[10px] text-secondary hover:text-primary"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        clientUi().openSettings('hooks')
      }}>
      <AlertTriangle size={11} />
      Hooks off
    </button>
  )
}
