import path from 'node:path'
import { CATE_HOOK_MARKER, type AgentHookTrust } from '../../contract'
import { readCodexInspection } from './codexInspection'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Only Cate's hooks in the requested checkout count. Unrelated user hooks
 * cannot make Cate look blocked or ready. Unsupported protocols stay unknown. */
export function codexHookTrust(response: unknown, cwd: string): AgentHookTrust {
  const data = record(response).data
  if (!Array.isArray(data)) return 'unknown'
  const entry = data.map(record).find((item) => item.cwd === cwd)
  if (!entry || !Array.isArray(entry.hooks) || (Array.isArray(entry.errors) && entry.errors.length)) return 'unknown'
  const hooks = entry.hooks.map(record).filter((hook) =>
    hook.sourcePath === path.join(cwd, '.codex', 'hooks.json')
    && hook.handlerType === 'command' && typeof hook.command === 'string' && hook.command.includes(CATE_HOOK_MARKER))
  if (!hooks.length) return 'unknown'
  if (hooks.some((hook) => hook.trustStatus === 'untrusted' || hook.trustStatus === 'modified')) return 'approval-required'
  return hooks.every((hook) => hook.enabled === true && (hook.trustStatus === 'trusted' || hook.trustStatus === 'managed'))
    ? 'trusted' : 'unknown'
}

export async function readCodexHookTrust(cwd: string): Promise<AgentHookTrust> {
  return codexHookTrust(await readCodexInspection(cwd, 'hooks/list', { cwds: [cwd] }), cwd)
}
