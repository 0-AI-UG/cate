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
