// Codex approval configuration: whether a Codex permission-check will be
// answered by a human (manual) or an automatic reviewer, read from the
// resolved config through Codex's own app-server `config/read`. Runs on the
// runtime's machine, where the CLI and its config live.

import { spawn } from 'node:child_process'
import path from 'node:path'
import type { AgentApprovalDetection, AgentId } from '../../contract'

const unknown = (detail: string): AgentApprovalDetection => ({ source: 'config', mode: 'unknown', detail })
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Interpret only approval metadata; never forward the full config (which may
 * include provider credentials) to a renderer or a log. */
export function codexApprovalFromConfig(response: unknown): AgentApprovalDetection {
  const result = record(response)
  if (!result.config || typeof result.config !== 'object') return unknown('Codex did not return its configuration.')
  const config = record(result.config)
  const reviewer = config.approvals_reviewer ?? 'user'
  const policy = config.approval_policy
  const key = policy === 'never' ? 'approval_policy' : 'approvals_reviewer'
  const value = key === 'approval_policy' ? policy : reviewer
  const mode = policy === 'never' || reviewer === 'auto_review' || reviewer === 'guardian_subagent'
    ? 'automatic' : reviewer === 'user' ? 'manual' : 'unknown'
  if (mode === 'unknown') return unknown('Codex did not report an approval reviewer.')
  const origin = record(record(record(result.origins)[key]).name)
  const location = typeof origin.file === 'string' ? origin.file
    : typeof origin.dotCodexFolder === 'string' ? path.join(origin.dotCodexFolder, 'config.toml')
    : typeof origin.type === 'string' ? origin.type : config.approvals_reviewer == null && policy !== 'never' ? 'Codex default' : 'Codex resolved configuration'
  const profile = typeof origin.profile === 'string' ? ` (profile: ${origin.profile})` : ''
  return { source: 'config', mode, detail: `${location}${profile}: ${key} = ${String(value)}` }
}

/** Ask Codex to read its own config layers. No conversation is created and no
 * approval settings are changed. Bounded and fail-neutral if the CLI is absent
 * or its protocol differs. Works on the host that owns the workspace. */
export function readCodexApprovalConfig(
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; command?: string; timeoutMs?: number } = {},
): Promise<AgentApprovalDetection> {
  return new Promise((resolve) => {
    const child = spawn(options.command ?? 'codex', ['app-server'], {
      cwd, env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      // npm installs `codex.cmd` on Windows, which only a shell runs.
      shell: process.platform === 'win32',
    })
    let done = false
    let buffer = ''
    let bytes = 0
    const finish = (value: AgentApprovalDetection) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.stdin.destroy()
      child.kill()
      resolve(value)
    }
    const timer = setTimeout(() => finish(unknown('Reading Codex configuration timed out.')), options.timeoutMs ?? 3000)
    const send = (message: unknown) => { if (!done) child.stdin.write(JSON.stringify(message) + '\n') }
    child.on('error', () => finish(unknown('Codex configuration could not be read on this host.')))
    child.on('exit', () => finish(unknown('Codex closed before reporting its configuration.')))
    child.stdin.on('error', () => finish(unknown('Codex configuration could not be read.')))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 4 * 1024 * 1024) { finish(unknown('Codex configuration response was too large.')); return }
      buffer += chunk
      let newline: number
      while (!done && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message: Record<string, unknown>
        try { message = record(JSON.parse(line)) } catch { continue }
        if (message.id === 1) {
          if (message.error) { finish(unknown('Codex rejected configuration inspection.')); return }
          send({ method: 'initialized', params: {} })
          send({ id: 2, method: 'config/read', params: { cwd, includeLayers: false } })
        } else if (message.id === 2) {
          finish(message.error ? unknown('Codex could not resolve this workspace’s configuration.') : codexApprovalFromConfig(message.result))
        }
      }
    })
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'cate_config_inspection', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    } })
  })
}

/** How a CLI whose approvals are told apart by config (`source: 'config'` in
 *  AGENT_APPROVAL_DETECTION) has its resolved config read, and which env keys
 *  that config depends on (the cache key). */
export interface ApprovalConfigReader {
  envKeys: readonly string[]
  read(cwd: string, options: { env?: NodeJS.ProcessEnv }): Promise<AgentApprovalDetection>
}

export const APPROVAL_CONFIG_READERS: Partial<Record<AgentId, ApprovalConfigReader>> = {
  codex: { envKeys: ['CODEX_HOME', 'HOME', 'PATH'], read: (cwd, options) => readCodexApprovalConfig(cwd, options) },
}
