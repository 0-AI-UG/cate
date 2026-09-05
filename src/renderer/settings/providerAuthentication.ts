import { T3_AGENTS } from '../../shared/agents'
import type { AgentProviderId } from '../../shared/t3Agent'

export interface AgentProviderLogin {
  id: AgentProviderId
  name: string
  description: string
}

const descriptions: Record<AgentProviderId, string> = {
  codex: 'ChatGPT account or OpenAI API key',
  claude: 'Claude account or Anthropic API key',
  cursor: 'Cursor account or API key',
  grok: 'xAI account',
  opencode: 'Choose and authenticate an OpenCode model provider',
}

export const AGENT_PROVIDER_LOGINS: readonly AgentProviderLogin[] = T3_AGENTS.map((agent) => ({
  id: agent.t3.providerId,
  name: agent.displayName,
  description: descriptions[agent.t3.providerId],
}))
