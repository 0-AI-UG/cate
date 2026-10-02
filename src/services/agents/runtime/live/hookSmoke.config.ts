import { AGENTS, type AgentId } from '../../contract'

export const HOOK_SMOKE_CREDENTIALS: Record<AgentId, string> = {
  'claude-code': 'OPENROUTER_API_KEY',
  codex: 'OPENROUTER_API_KEY',
  cursor: 'CURSOR_API_KEY',
  grok: 'XAI_API_KEY',
  hermes: 'OPENROUTER_API_KEY',
  kiro: 'KIRO_API_KEY',
  opencode: 'OPENROUTER_API_KEY',
}

/** An explicit selection must never turn a misspelling into a green, empty run. */
export function selectHookSmokeAgents(selection?: string): AgentId[] {
  if (selection === undefined) return AGENTS.map((agent) => agent.id)
  const ids = selection.split(',').map((id) => id.trim())
  for (const id of ids) {
    if (!AGENTS.some((agent) => agent.id === id)) throw new Error(`Unknown hook smoke agent: ${JSON.stringify(id)}`)
  }
  return [...new Set(ids)] as AgentId[]
}

export function redactHookSmokeOutput(output: string, env: NodeJS.ProcessEnv): string {
  for (const [key, value] of Object.entries(env)) {
    if (value && value.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD/i.test(key)) output = output.replaceAll(value, '[REDACTED]')
  }
  return output
}
