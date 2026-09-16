import { AGENTS, matchAgentDef } from '../../../shared/agents'
import { useAppStore } from '../../stores/appStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useStatusStore } from '../../stores/statusStore'
import { panelRelationContextForSend } from '../agent/panelRelationPrompt'
import { connectedEditors, flushConnectedEditors } from '../editor/connectedEditors'
import { getEntry, ptyToPanel } from './registryState'

const pending = new Map<string, Promise<void>>()

/** Keep PTY input ordered while a submit waits for connected editor autosaves. */
export function writeTerminalInput(ptyId: string, data: string): Promise<void> {
  const panelId = ptyToPanel.get(ptyId)
  const workspace = panelId ? useAppStore.getState().workspaces.find(ws => ws.panels[panelId]) : undefined
  const prepare = !!workspace && !!panelId && /[\r\n]|\x1b\[13;\d+u/.test(data)
    && useSettingsStore.getState().panelRelationsEnabled && connectedEditors(workspace, panelId).length > 0
  const previous = pending.get(ptyId)
  if (!previous && !prepare) return Promise.resolve(window.electronAPI.terminalWrite(ptyId, data))
  const write = async () => {
    if (prepare) {
      await flushConnectedEditors(workspace.id, panelId)
      const status = useStatusStore.getState().workspaces[workspace.id]?.terminals[ptyId]
      const agent = (status?.activity.type === 'running' && status.activity.processName ? matchAgentDef(status.activity.processName) : null)
        ?? (status?.agentPresent ? AGENTS.find(item => item.displayName === status.agentName) : null)
      // Publish the materialized paths before Enter can invoke a native hook.
      if (agent?.promptContextHook) await window.electronAPI.agentHooksSetPromptContext(
        ptyId, panelRelationContextForSend(workspace.id, panelId, agent.id),
      )
    }
    await window.electronAPI.terminalWrite(ptyId, data)
  }
  const operation = previous ? previous.then(write) : write()
  pending.set(ptyId, operation)
  const clear = () => { if (pending.get(ptyId) === operation) pending.delete(ptyId) }
  void operation.then(clear, clear)
  return operation
}

/** Native keystrokes have no caller to display an IPC error. */
export function reportTerminalWriteError(ptyId: string, error: unknown): void {
  const panelId = ptyToPanel.get(ptyId)
  const message = error instanceof Error ? error.message : 'Could not send terminal input.'
  if (panelId) getEntry(panelId)?.terminal.write(`\r\n${message.replace(/[\x00-\x1f\x7f]/g, ' ')}\r\n`)
}
