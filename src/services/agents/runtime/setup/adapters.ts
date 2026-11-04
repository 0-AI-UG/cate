import type { AgentId, AgentSetupAuthentication } from '../../contract'

interface Command { executable: string; args: string[] }
export interface AgentSetupAdapter {
  downloadUrl: string
  login: readonly string[]
  loginHint?: string
  /** CLI-native extension that opens or prepares its interactive login UI. */
  loginExtension?: string
  minimumVersion?: string
  status: readonly string[] | null
  apiProtocol: 'messages' | 'responses' | 'chat-completions' | null
  apiReason?: string
  installer: { unix?: Command; windows?: Command }
}
const installScript = (url: string): Command => ({ executable: '/bin/bash', args: ['-o', 'pipefail', '-c', `curl --fail --show-error --silent --location '${url}' | bash`] })
const powershellScript = (url: string): Command => ({ executable: 'powershell.exe', args: ['-NoProfile', '-Command', `Invoke-RestMethod '${url}' | Invoke-Expression`] })
export const AGENT_SETUP_ADAPTERS: Record<AgentId, AgentSetupAdapter> = {
  'claude-code': { downloadUrl: 'https://code.claude.com/docs/en/setup', login: ['auth', 'login'], status: ['auth', 'status', '--json'], apiProtocol: 'messages', installer: { unix: installScript('https://claude.ai/install.sh'), windows: powershellScript('https://claude.ai/install.ps1') } },
  codex: { downloadUrl: 'https://developers.openai.com/codex/cli/', login: ['login', '--device-auth'], status: ['login', 'status'], apiProtocol: 'responses', installer: { unix: { executable: 'npm', args: ['install', '-g', '@openai/codex'] }, windows: { executable: 'powershell.exe', args: ['-NoProfile', '-Command', 'npm install -g @openai/codex'] } } },
  cursor: { downloadUrl: 'https://cursor.com/cli', login: ['login'], status: ['status', '--format', 'json'], apiProtocol: null, apiReason: 'Cursor uses its own agent service protocol; its endpoint flag is not an OpenAI or Anthropic inference gateway.', installer: { unix: installScript('https://cursor.com/install') } },
  grok: { downloadUrl: 'https://docs.x.ai/build/cli', login: ['login', '--device-auth'], status: null, apiProtocol: 'chat-completions', installer: { unix: installScript('https://x.ai/cli/install.sh'), windows: powershellScript('https://x.ai/cli/install.ps1') } },
  kiro: { downloadUrl: 'https://kiro.dev/downloads/', login: ['login', '--use-device-flow'], status: ['whoami', '--format', 'json'], apiProtocol: null, apiReason: 'Kiro uses its subscription agent service; a custom inference gateway is not supported.', installer: { unix: installScript('https://cli.kiro.dev/install'), windows: powershellScript('https://cli.kiro.dev/install.ps1') } },
  pi: { downloadUrl: 'https://pi.dev', login: [], loginHint: 'Run /login in the Pi terminal to choose a provider and sign in. Close the terminal when finished.', minimumVersion: '1.4.0', loginExtension: 'export default function (pi) { pi.on("session_start", (_event, ctx) => { ctx.ui.setEditorText("/login"); ctx.ui.notify("Press Enter to sign in to Pi, then close this setup terminal.", "info") }) }', status: null, apiProtocol: 'chat-completions', installer: { unix: { executable: 'npm', args: ['install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent'] }, windows: { executable: 'powershell.exe', args: ['-NoProfile', '-Command', 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent'] } } },
  opencode: { downloadUrl: 'https://opencode.ai/docs/', login: ['auth', 'login'], status: ['auth', 'list'], apiProtocol: 'chat-completions', installer: { unix: { executable: 'npm', args: ['install', '-g', 'opencode-ai'] }, windows: { executable: 'powershell.exe', args: ['-NoProfile', '-Command', 'npm install -g opencode-ai'] } } },
}
const string = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 320 && !/[\r\n\x00-\x1f]/.test(value) ? value : undefined
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
/** Allowlist public identity fields; never forward raw CLI output or tokens. */
export function setupAuthentication(agentId: AgentId, output: string, exitCode: number): AgentSetupAuthentication {
  let parsed: Record<string, unknown> = {}
  try { parsed = object(JSON.parse(output)) } catch { /* Older CLIs have text status. */ }
  const account = object(parsed.account)
  const user = object(parsed.user)
  const email = string(parsed.email ?? account.email ?? user.email)
  const displayName = string(parsed.name ?? account.name ?? user.name)
  const plan = string(parsed.subscriptionType ?? parsed.planType ?? parsed.plan ?? account.planType)
  let method = string(parsed.authMethod ?? parsed.method ?? parsed.provider ?? parsed.accountType)
  let signedIn: boolean | undefined
  if (typeof parsed.loggedIn === 'boolean') signedIn = parsed.loggedIn
  else if (typeof parsed.isAuthenticated === 'boolean') signedIn = parsed.isAuthenticated
  else if (parsed.status === 'authenticated') signedIn = true
  else if (parsed.status === 'unauthenticated') signedIn = false
  else if (email || displayName) signedIn = true
  if (agentId === 'codex') {
    if (/not logged in/i.test(output)) signedIn = false
    else if (/logged in/i.test(output) && exitCode === 0) signedIn = true
    else if (/API key configured/i.test(output) && exitCode === 0) { signedIn = true; method = 'api_key' }
  }
  if (agentId === 'kiro' && /not (?:logged|signed) in|not authenticated/i.test(output)) signedIn = false
  if (agentId === 'kiro' && parsed.account === null) signedIn = false
  if (agentId === 'kiro' && parsed.accountType === 'ApiKey' && exitCode === 0) signedIn = true
  if (agentId === 'opencode') {
    const count = output.match(/(\d+) credentials?/i)
    if (count) signedIn = Number(count[1]) > 0
  }
  return { status: signedIn === true ? 'signed-in' : signedIn === false ? 'signed-out' : 'unknown', ...(email ? { email } : {}), ...(displayName ? { displayName } : {}), ...(plan ? { plan } : {}), ...(method ? { method } : {}), ...(signedIn === undefined ? { detail: 'This CLI did not report a readable account identity.' } : {}) }
}
