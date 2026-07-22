// =============================================================================
// agentModelPrefs — the user-pinned default model applied to every brand-new
// chat. Persisted in settings.json (key `agentDefaultModel`) via the settings
// store, so it is hand-editable and exportable alongside the rest of settings.
// =============================================================================

import type { AgentModelRef } from '../../shared/types'
import { launchCommandForAgent } from '../../shared/agents'
import { useSettingsStore } from '../../renderer/stores/settingsStore'

export function loadDefaultModel(): AgentModelRef | null {
  const m = useSettingsStore.getState().agentDefaultModel
  if (m && typeof m.provider === 'string' && typeof m.model === 'string') return m
  return null
}

export function saveDefaultModel(model: AgentModelRef | null): void {
  useSettingsStore.getState().setSetting('agentDefaultModel', model)
}

/** Drop the saved default model if it points at a provider the user just
 *  disconnected, so a stale pick doesn't resurface as a "reconnect" prompt.
 *  Per-chat model overrides live on their own chat records and are left alone. */
export function clearModelPrefsForProvider(providerId: string): void {
  if (loadDefaultModel()?.provider === providerId) saveDefaultModel(null)
}

/** The CLI command each iteration's driver launches, resolved from the AgentId
 *  picked in Settings → Cate Agent (key `cateAgentOrchestratorAgentId`). Empty
 *  when nothing is picked — the driver then chooses an installed one itself. */
export function loadCateAgentOrchestratorAgentCommand(): string {
  const v = useSettingsStore.getState().cateAgentOrchestratorAgentId
  const id = typeof v === 'string' ? v.trim() : ''
  return launchCommandForAgent(id) ?? ''
}
