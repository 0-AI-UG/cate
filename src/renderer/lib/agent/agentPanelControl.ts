import { useAppStore } from '../../stores/appStore'
import { useStatusStore } from '../../stores/statusStore'
import { useT3ActivityStore } from '../../stores/t3ActivityStore'
import { submitTerminalText } from '../terminal/terminalDriver'
import { terminalRegistry } from '../terminal/terminalRegistry'
import { canT3ThreadReceivePrompt } from '../t3ThreadState'
import { canAgentReceivePrompt } from './agentScreenDetector'

type AgentPanelSender = (prompt: string) => Promise<boolean>
const agentPanelSenders = new Map<string, AgentPanelSender>()

/** Register the private submission adapter for an embedded agent surface. */
export function registerAgentPanelSender(panelId: string, sender: AgentPanelSender): () => void {
  agentPanelSenders.set(panelId, sender)
  return () => {
    if (agentPanelSenders.get(panelId) === sender) agentPanelSenders.delete(panelId)
  }
}

/** One panel-addressed control path for terminal CLI agents and embedded T3.
 * Hook/activity state validates the target; surface adapters own submission. */
export async function sendPromptToAgentPanel(
  workspaceId: string,
  panelId: string,
  prompt: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const workspace = useAppStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)
  const panel = workspace?.panels[panelId]
  if (!panel || (panel.type !== 'terminal' && panel.type !== 'agent')) {
    return { ok: false, error: 'agent-panel-not-found' }
  }
  if (panel.type === 'terminal') {
    const entry = terminalRegistry.getEntry(panelId)
    const status = entry?.ptyId
      ? useStatusStore.getState().workspaces[workspaceId]?.terminals[entry.ptyId]
      : undefined
    if (!status?.agentPresent) return { ok: false, error: 'agent-not-running' }
    if (!canAgentReceivePrompt(entry!.ptyId!)) return { ok: false, error: 'agent-busy' }
  } else {
    const t3 = useT3ActivityStore.getState()
    const binding = t3.panels[panelId]
    const thread = binding?.threadId ? t3.instances[binding.partition]?.threads[binding.threadId] : undefined
    if (!binding?.connected || !thread) return { ok: false, error: 'agent-not-running' }
    if (!canT3ThreadReceivePrompt(thread)) return { ok: false, error: 'agent-busy' }
  }
  const sent = panel.type === 'terminal'
    ? await submitTerminalText(panelId, prompt)
    : await agentPanelSenders.get(panelId)?.(prompt) === true
  return sent ? { ok: true } : { ok: false, error: 'agent-panel-unavailable' }
}
