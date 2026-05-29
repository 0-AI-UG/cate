// =============================================================================
// agentModelPrefs — localStorage-backed model selection prefs for the agent
// panel. One slot:
//   - defaultModel: the user-pinned default, applied to every brand-new chat
// =============================================================================

import type { AgentModelRef } from '../../shared/types'

const DEFAULT_MODEL_KEY = 'cate.agent.defaultModel.v1'

export function loadDefaultModel(): AgentModelRef | null {
  return readModelRef(DEFAULT_MODEL_KEY)
}

export function saveDefaultModel(model: AgentModelRef | null): void {
  try {
    if (model) localStorage.setItem(DEFAULT_MODEL_KEY, JSON.stringify(model))
    else localStorage.removeItem(DEFAULT_MODEL_KEY)
  } catch { /* */ }
}

function readModelRef(key: string): AgentModelRef | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.provider === 'string' && typeof parsed.model === 'string') {
      return parsed as AgentModelRef
    }
  } catch { /* */ }
  return null
}
