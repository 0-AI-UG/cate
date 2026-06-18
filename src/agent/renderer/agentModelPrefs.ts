// =============================================================================
// agentModelPrefs — the user-pinned default model applied to every brand-new
// chat. Persisted in settings.json (key `agentDefaultModel`) via the settings
// store, so it is hand-editable and exportable alongside the rest of settings.
// (It lived in renderer localStorage before; see settingsStore for the one-time
// migration of the legacy `cate.agent.defaultModel.v1` key.)
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
// Both headless Cate Agent brains (observer + executor) run on this single
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

/** The coding agent (an AgentId) the executor launches in terminals, or '' to
 *  let it choose. */
export function loadCateAgentExecutorAgentId(): string {
  const v = useSettingsStore.getState().cateAgentExecutorAgentId
  return typeof v === 'string' ? v.trim() : ''
}

export function saveCateAgentExecutorAgentId(id: string): void {
  useSettingsStore.getState().setSetting('cateAgentExecutorAgentId', id)
}

/** The CLI command the executor launches, resolved from the picked AgentId.
 *  Empty when nothing is picked (the executor then chooses one itself). */
export function loadCateAgentExecutorAgentCommand(): string {
  return launchCommandForAgent(loadCateAgentExecutorAgentId()) ?? ''
}
