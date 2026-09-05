export interface AgentProviderLogin {
  id: 'codex' | 'claude' | 'cursor' | 'grok' | 'opencode'
  name: string
  description: string
}

export const AGENT_PROVIDER_LOGINS: readonly AgentProviderLogin[] = [
  {
    id: 'codex',
    name: 'Codex',
    description: 'ChatGPT account or OpenAI API key',
  },
  {
    id: 'claude',
    name: 'Claude',
    description: 'Claude account or Anthropic API key',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    description: 'Cursor account or API key',
  },
  {
    id: 'grok',
    name: 'Grok',
    description: 'xAI account',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'Choose and authenticate an OpenCode model provider',
  },
]
