import { T3_AGENTS } from '../../shared/agents'
import type { AgentProviderId } from '../../shared/t3Agent'

export interface ProviderAuthCommand {
  executable: string
  args: string[]
}

const COMMANDS: Record<AgentProviderId, ProviderAuthCommand> = {
  codex: { executable: 'codex', args: ['login', '--device-auth'] },
  claude: { executable: 'claude', args: ['auth', 'login'] },
  cursor: { executable: 'cursor-agent', args: ['login'] },
  grok: { executable: 'grok', args: ['login', '--device-auth'] },
  opencode: { executable: 'opencode', args: ['auth', 'login'] },
}

export function providerAuthCommand(
  providerId: AgentProviderId,
  provider?: string,
): ProviderAuthCommand {
  const command = COMMANDS[providerId]
  if (providerId !== 'opencode' || !provider?.trim()) return command
  return {
    ...command,
    args: [...command.args, '--provider', provider.trim()],
  }
}

export interface ProviderAuthLaunch {
  command: ProviderAuthCommand
  env: Record<string, string>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Mirror T3's `~` expansion. `homeDir` is null when the runtime's home is unknown. */
function expandHome(value: string, homeDir: string | null): string {
  if (!homeDir || (value !== '~' && !/^~[\\/]/.test(value))) return value
  return `${homeDir}${value.slice(1)}`
}

/** Launch the login with the same binary and home directory T3 uses for the
 * provider, so credentials land where the provider will look for them. */
export function providerAuthLaunch(
  providerId: AgentProviderId,
  profile: Record<string, unknown> | null,
  homeDir: string | null,
  provider?: string,
): ProviderAuthLaunch {
  const base = providerAuthCommand(providerId, provider)
  const driverId = T3_AGENTS.find((agent) => agent.t3.providerId === providerId)?.t3.driverId ?? providerId
  const providers = profile?.providers && typeof profile.providers === 'object'
    ? profile.providers as Record<string, unknown>
    : {}
  const raw = providers[driverId]
  const config = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const binaryPath = text(config.binaryPath)
  const env: Record<string, string> = {}
  if (providerId === 'codex') {
    const home = text(config.shadowHomePath) || text(config.homePath)
    if (home) env.CODEX_HOME = expandHome(home, homeDir)
  }
  if (providerId === 'claude' && text(config.homePath)) {
    env.CLAUDE_CONFIG_DIR = expandHome(text(config.homePath), homeDir)
  }
  return {
    command: binaryPath ? { ...base, executable: expandHome(binaryPath, homeDir) } : base,
    env,
  }
}

export function cleanProviderAuthOutput(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

export function providerAuthUrl(output: string): string | undefined {
  const match = cleanProviderAuthOutput(output).match(/https:\/\/[^\s<>"']+/i)
  return match?.[0].replace(/[),.;]+$/, '')
}

export function providerAuthCode(output: string): string | undefined {
  return cleanProviderAuthOutput(output).match(/\b[A-Z0-9]{3,6}-[A-Z0-9]{3,6}\b/)?.[0]
}
