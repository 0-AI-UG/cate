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

/** Drop every saved model preference that points at a provider the user just
 *  disconnected, so a stale pick doesn't resurface as a "reconnect" prompt. */
export function clearModelPrefsForProvider(providerId: string): void {
  if (loadDefaultModel()?.provider === providerId) saveDefaultModel(null)
  if (loadCateAgentModel()?.provider === providerId) saveCateAgentModel(null)
}

// --- Cate Agent model -------------------------------------------------------
// Both headless Cate Agent brains (observer + orchestrator) run on this single
// user-chosen model (Settings → Cate Agent). null means "fall back to a default".

function readModel(value: AgentModelRef | null): AgentModelRef | null {
  if (value && typeof value.provider === 'string' && typeof value.model === 'string') return value
  return null
}

export function loadCateAgentModel(): AgentModelRef | null {
  return readModel(useSettingsStore.getState().cateAgentModel)
}

export function saveCateAgentModel(model: AgentModelRef | null): void {
  useSettingsStore.getState().setSetting('cateAgentModel', model)
}

/** The CLI command each iteration's driver launches, resolved from the AgentId
 *  picked in Settings → Cate Agent (key `cateAgentOrchestratorAgentId`). Empty
 *  when nothing is picked — the driver then chooses an installed one itself. */
export function loadCateAgentOrchestratorAgentCommand(): string {
  const v = useSettingsStore.getState().cateAgentOrchestratorAgentId
  const id = typeof v === 'string' ? v.trim() : ''
  return launchCommandForAgent(id) ?? ''
}
