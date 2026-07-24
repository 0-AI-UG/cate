// =============================================================================
// agentModelPrefs — the user-pinned default model applied to every brand-new
// chat. Persisted in settings.json (key `agentDefaultModel`) via the settings
// store, so it is hand-editable and exportable alongside the rest of settings.
// =============================================================================

import type { CateAgentModelRef } from '../../shared/types'
import { resolveEffectiveAgentModel } from '../../shared/agentModels'
import { useSettingsStore } from '../../renderer/stores/settingsStore'

export function loadDefaultModel(): CateAgentModelRef | null {
  const m = useSettingsStore.getState().agentDefaultModel
  if (m && typeof m.provider === 'string' && typeof m.model === 'string') return m
  return null
}

export function saveDefaultModel(model: CateAgentModelRef | null): void {
  useSettingsStore.getState().setSetting('agentDefaultModel', model)
}

/** Resolve a new renderer-owned session against the live model catalog.
 * Explicit chat choices remain strict; only the shared default may fall back. */
export async function resolveSessionModel(
  explicit?: CateAgentModelRef | null,
): Promise<CateAgentModelRef | null> {
  if (explicit) return explicit
  const configuredDefault = loadDefaultModel()
  try {
    const models = await window.electronAPI.agentListModels()
    return resolveEffectiveAgentModel(
      undefined,
      configuredDefault,
      models.map((model) => ({ provider: model.provider, model: model.id })),
    )
  } catch {
    // If the catalog itself is temporarily unavailable, preserve the existing
    // preference rather than silently changing which provider a session uses.
    return configuredDefault
  }
}

/** Drop the saved default model if it points at a provider the user just
 *  disconnected, so a stale pick doesn't resurface as a "reconnect" prompt.
 *  Per-chat model overrides live on their own chat records and are left alone. */
export function clearModelPrefsForProvider(providerId: string): void {
  if (loadDefaultModel()?.provider === providerId) saveDefaultModel(null)
}
