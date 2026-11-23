// Codex approval configuration: whether a Codex permission-check will be
// answered by a human (manual) or an automatic reviewer, read from the
// resolved config through Codex's own app-server `config/read`. Runs on the
// runtime's machine, where the CLI and its config live.

import { CODEX_INSPECTION_ENV_KEYS, readCodexInspection } from './codexInspection'
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
  return readCodexInspection(cwd, 'config/read', { cwd, includeLayers: false }, options).then(codexApprovalFromConfig)
}

/** How a CLI whose approvals are told apart by config (`source: 'config'` in
 *  AGENT_APPROVAL_DETECTION) has its resolved config read, and which env keys
 *  that config depends on (the cache key). */
export interface ApprovalConfigReader {
  envKeys: readonly string[]
  read(cwd: string, options: { env?: NodeJS.ProcessEnv }): Promise<AgentApprovalDetection>
}

export const APPROVAL_CONFIG_READERS: Partial<Record<AgentId, ApprovalConfigReader>> = {
  codex: { envKeys: CODEX_INSPECTION_ENV_KEYS, read: (cwd, options) => readCodexApprovalConfig(cwd, options) },
}
