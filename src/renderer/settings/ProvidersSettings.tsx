// =============================================================================
// ProvidersSettings — the agent ProvidersView embedded under Settings → Cate
// Agent. Provider credentials (auth.json) and the custom OpenAI endpoint
// (models.json) are GLOBAL and shared across every workspace (mirrored into each
// workspace's .cate/cate-agent/), so the unified chat setup owns them.
//
// Storage is unchanged: ProvidersView talks to the same global AUTH_* /
// CODING_CUSTOM_MODELS_* IPC whether it is rendered here or inside the agent
// panel. `embedded` drops its internal header so this section owns the chrome.
// =============================================================================

import { ProvidersView } from '../../cateAgent/renderer/ProvidersView'
import { SearchableBlock } from './SettingsComponents'

export function ProvidersSettings() {
  return (
    <SearchableBlock keywords="providers models default model sign in api key oauth anthropic openai google mistral custom endpoint">
      <div className="flex flex-col gap-1">
        <p className="text-xs text-secondary mb-2">
          Sign in to AI providers or store API keys. These credentials are shared by
          every workspace and copied into each one for the agent to use.
        </p>
        <ProvidersView embedded />
      </div>
    </SearchableBlock>
  )
}
