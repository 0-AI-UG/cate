// =============================================================================
// agentModelPrefs — localStorage-backed model selection prefs for the agent
// panel. Two slots:
//   - lastModel: the most recently chosen model in any chat (used as a
//     fallback when filling the picker before auth has resolved)
//   - defaultModel: the user-pinned default, applied to every brand-new chat
// =============================================================================

import type { AgentModelRef } from '../../shared/types'

const LAST_MODEL_KEY = 'cate.agent.lastModel.v1'
const DEFAULT_MODEL_KEY = 'cate.agent.defaultModel.v1'

export function loadLastModel(): AgentModelRef | null {
  return readModelRef(LAST_MODEL_KEY)
}

export function saveLastModel(model: AgentModelRef): void {
  try { localStorage.setItem(LAST_MODEL_KEY, JSON.stringify(model)) } catch { /* */ }
}

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
