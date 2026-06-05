// =============================================================================
// ProvidersSettings — the agent ProvidersView surfaced as a main-Settings
// section. Provider credentials (auth.json) and the custom OpenAI endpoint
// (models.json) are GLOBAL and shared across every workspace (mirrored into each
// workspace's .cate/pi-agent/), so they belong here alongside the rest of the
// app settings, not only in the per-panel agent settings view.
//
// Storage is unchanged: ProvidersView talks to the same global AUTH_* /
// AGENT_CUSTOM_MODELS_* IPC whether it is rendered here or inside the agent
// panel. `embedded` drops its internal header so this section owns the chrome.
// =============================================================================

import { ProvidersView } from '../../agent/renderer/ProvidersView'

export function ProvidersSettings() {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-secondary mb-2">
        Sign in to AI providers or store API keys. These credentials are shared by
        every workspace and copied into each one for the agent to use.
      </p>
      <ProvidersView embedded />
    </div>
  )
}
