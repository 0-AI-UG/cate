import { useAppStore } from '../../stores/appStore'
import { useStatusStore } from '../../stores/statusStore'
import { t3PanelConnected, t3ThreadForPanel, useT3ActivityStore } from '../../stores/t3ActivityStore'
import { submitTerminalText } from '../terminal/terminalDriver'
import { terminalRegistry } from '../terminal/terminalRegistry'
import { canT3ThreadReceivePrompt } from '../t3ThreadState'
import { canAgentReceivePrompt } from './agentScreenDetector'
import { agentPanelCwd } from './agentSessionRef'
import { preparePanelRelationContextForSend } from './panelRelationPrompt'
import { agentIdForT3Provider } from '../../../shared/agents'

type AgentPanelSender = (prompt: string) => Promise<boolean>
const agentPanelSenders = new Map<string, AgentPanelSender>()

/** Register the page composer of a mounted T3 panel. Only a fresh chat (no
 * thread yet) needs it: the composer's provider/model selection creates the
 * thread. Bound threads are sent through main. */
export function registerAgentPanelSender(panelId: string, sender: AgentPanelSender): () => void {
  agentPanelSenders.set(panelId, sender)
  return () => {
    if (agentPanelSenders.get(panelId) === sender) agentPanelSenders.delete(panelId)
  }
}

/** Why a T3 panel cannot take a prompt now, or undefined when it can. The
 * harness shell stream must be live; a bound thread must be in its snapshot
 * so its state is known. A panel with no thread is a fresh chat: its first
 * prompt creates the thread. */
export function t3PromptBlocker(
  panelId: string,
  threadId: string | undefined,
  t3 = useT3ActivityStore.getState(),
): 'agent-not-running' | 'agent-busy' | undefined {
  const thread = t3ThreadForPanel(t3, panelId)
  if (!t3PanelConnected(t3, panelId) || (threadId && !thread)) return 'agent-not-running'
  return thread && !canT3ThreadReceivePrompt(thread) ? 'agent-busy' : undefined
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
  if (!workspace || !panel || (panel.type !== 'terminal' && panel.type !== 'agent')) {
    return { ok: false, error: 'agent-panel-not-found' }
  }
  if (panel.type === 'terminal') {
    const entry = terminalRegistry.getEntry(panelId)
    const status = entry?.ptyId
      ? useStatusStore.getState().workspaces[workspaceId]?.terminals[entry.ptyId]
      : undefined
    if (!status?.agentPresent) return { ok: false, error: 'agent-not-running' }
    if (!canAgentReceivePrompt(entry!.ptyId!)) return { ok: false, error: 'agent-busy' }
    return await submitTerminalText(panelId, prompt) ? { ok: true } : { ok: false, error: 'agent-panel-unavailable' }
  }
  const threadId = panel.agentThreadId
  const blocker = t3PromptBlocker(panelId, threadId)
  if (blocker) return { ok: false, error: blocker }
  if (!threadId) {
    const sent = await agentPanelSenders.get(panelId)?.(prompt).catch(() => false)
    return sent === true ? { ok: true } : { ok: false, error: 'agent-panel-unavailable' }
  }
  const provider = t3ThreadForPanel(useT3ActivityStore.getState(), panelId)?.session?.providerName
  let context: string | null
  try {
    context = await preparePanelRelationContextForSend(workspaceId, panelId, provider ? agentIdForT3Provider(provider) : null)
  } catch {
    return { ok: false, error: 'editor-sync-failed' }
  }
  const result = await window.electronAPI.agentHarnessStartTurn({
    workspaceId, cwd: agentPanelCwd(workspace, panel), threadId, text: context ? `${prompt}\n\n${context}` : prompt,
  }).catch(() => ({ error: 'unavailable' }))
  return 'error' in result ? { ok: false, error: 'agent-panel-unavailable' } : { ok: true }
}
