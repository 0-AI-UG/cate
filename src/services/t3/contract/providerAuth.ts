import { isLoopbackUrl } from '@runtime/tunnel/contract'
import { t3Provider, type T3ProviderId } from './providers'

export interface ProviderAuthCommand {
  executable: string
  args: string[]
}

const COMMANDS: Record<T3ProviderId, ProviderAuthCommand> = {
  codex: { executable: 'codex', args: ['login', '--device-auth'] },
  claude: { executable: 'claude', args: ['auth', 'login'] },
  cursor: { executable: 'cursor-agent', args: ['login'] },
  grok: { executable: 'grok', args: ['login', '--device-auth'] },
  opencode: { executable: 'opencode', args: ['auth', 'login'] },
}

export function providerAuthCommand(providerId: T3ProviderId, provider?: string): ProviderAuthCommand {
  const command = COMMANDS[providerId]
  if (providerId !== 'opencode' || !provider?.trim()) return command
  return { ...command, args: [...command.args, '--provider', provider.trim()] }
}

export interface ProviderAuthLaunch {
  command: ProviderAuthCommand
  env: Record<string, string>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Mirror T3's `~` expansion. `homeDir` is null when the home is unknown: a
 *  literal `~` would resolve against the checkout. */
function expandHome(value: string, homeDir: string | null): string {
  if (value !== '~' && !/^~[\\/]/.test(value)) return value
  if (!homeDir) throw new Error(`Cate cannot expand "${value}" on this runtime. Use an absolute path in the provider settings.`)
  return `${homeDir}${value.slice(1)}`
}

/** Launch the login with the same binary and home directory T3 uses for the
 *  provider, so credentials land where the provider will look for them. */
export function providerAuthLaunch(
  providerId: T3ProviderId,
  profile: Record<string, unknown> | null,
  homeDir: string | null,
  provider?: string,
): ProviderAuthLaunch {
  const base = providerAuthCommand(providerId, provider)
  const driverId = t3Provider(providerId).driverId
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

/** True when the sign-in page at `url` is on, or sends the browser back to
 *  (its `redirect_uri` or `redirect` parameter), a loopback address: the
 *  provider CLI listens there on the runtime's machine, which only a Cate
 *  browser panel of the workspace reaches (architecture D10). */
export function providerAuthUsesLoopback(url: string): boolean {
  if (isLoopbackUrl(url)) return true
  try {
    const params = new URL(url).searchParams
    return ['redirect_uri', 'redirect'].some((key) => isLoopbackUrl(params.get(key) ?? ''))
  } catch {
    return false
  }
}

export function providerAuthCode(output: string): string | undefined {
  return cleanProviderAuthOutput(output).match(/\b[A-Z0-9]{3,6}-[A-Z0-9]{3,6}\b/)?.[0]
}
