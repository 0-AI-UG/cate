import path from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir, symlink, lstat } from 'node:fs/promises'
import { writeFileAtomic } from '@kernel/state/node'
import type { LaunchCommand, LaunchPlan } from '@services/terminal/runtime'
import type { AgentId } from '../../contract'

export interface ProviderLaunchConfig { agentId: AgentId; baseUrl: string; credential: string; model: string; maxInputTokens?: number; maxOutputTokens?: number }
/** All secrets travel in the child environment; never argv, panel records or shell input. */
export async function providerLaunch(config: ProviderLaunchConfig, command: LaunchCommand, agentsDir: string): Promise<LaunchPlan> {
  const base = config.baseUrl.replace(/\/+$/, '')
  const env: Record<string, string> = { CATE_PROVIDER_API_KEY: config.credential }
  let args = [...command.args]
  switch (config.agentId) {
    case 'claude-code':
      Object.assign(env, { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: config.credential, CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '', ANTHROPIC_MODEL: config.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: config.model, ANTHROPIC_DEFAULT_SONNET_MODEL: config.model, ANTHROPIC_DEFAULT_OPUS_MODEL: config.model })
      args = ['--model', config.model, ...args]
      break
    case 'codex':
      args = ['-c', 'web_search="disabled"', '-c', 'model_provider="cate"', '-c', `model=${JSON.stringify(config.model)}`, '-c', 'model_providers.cate.name="API provider"', '-c', `model_providers.cate.base_url=${JSON.stringify(base)}`, '-c', 'model_providers.cate.env_key="CATE_PROVIDER_API_KEY"', '-c', 'model_providers.cate.wire_api="responses"', ...args]
      break
    case 'opencode': {
      const limit = {
        ...(config.maxInputTokens ? { context: config.maxInputTokens, input: config.maxInputTokens } : {}),
        ...(config.maxOutputTokens ? { output: config.maxOutputTokens } : {}),
      }
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { cate: { npm: '@ai-sdk/openai-compatible', name: 'API provider', options: { baseURL: base, apiKey: '{env:CATE_PROVIDER_API_KEY}' }, models: { [config.model]: { name: config.model, ...(Object.keys(limit).length ? { limit } : {}) } } } }, model: `cate/${config.model}`, small_model: `cate/${config.model}` })
      args = ['--model', `cate/${config.model}`, ...args]
      break
    }
    case 'pi': {
      // Explicit extension + provider selection also applies on session restore.
      // No native config/auth files are copied or rewritten, and an extension
      // load failure leaves an unknown provider rather than native billing.
      const key = createHash('sha256').update(JSON.stringify([base, config.model, config.maxInputTokens, config.maxOutputTokens])).digest('hex')
      const directory = path.join(agentsDir, 'pi-configs', key)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const extension = path.join(directory, 'cate-provider.js')
      const providerId = 'cate'
      const provider = {
        baseUrl: base, api: 'openai-completions', apiKey: '$CATE_PROVIDER_API_KEY', authHeader: true,
        models: [{ id: config.model, name: config.model, reasoning: false, input: ['text'],
          contextWindow: config.maxInputTokens ?? 128000, maxTokens: config.maxOutputTokens ?? 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      }
      await writeFileAtomic(extension, `export default function (pi) { pi.registerProvider(${JSON.stringify(providerId)}, ${JSON.stringify(provider)}) }\n`, { mode: 0o600 })
      args = ['--extension', extension, '--provider', providerId, '--model', config.model, '--models', `${providerId}/${config.model}`, ...args]
      break
    }
    case 'grok': {
      // GROK_CONFIG explicitly drops endpoint/model tables. Use a Cate-owned
      // home, sharing the managed transcript directory across configurations.
      const key = createHash('sha256').update(JSON.stringify([base, config.model])).digest('hex')
      const home = path.join(agentsDir, 'grok-configs', key)
      const sessions = path.join(agentsDir, 'grok-sessions')
      await mkdir(home, { recursive: true, mode: 0o700 })
      await mkdir(sessions, { recursive: true, mode: 0o700 })
      try { await lstat(path.join(home, 'sessions')) } catch { await symlink(sessions, path.join(home, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir') }
      await writeFileAtomic(path.join(home, 'config.toml'), [
        '[model.cate]', `model = ${JSON.stringify(config.model)}`, `base_url = ${JSON.stringify(base)}`, 'env_key = "CATE_PROVIDER_API_KEY"', 'api_backend = "chat_completions"', '[models]', 'default = "cate"', '[features]', 'remote_fetch = false', '',
      ].join('\n'), { mode: 0o600 })
      Object.assign(env, { GROK_HOME: home, XAI_API_KEY: '', GROK_CODE_XAI_API_KEY: '' })
      args = ['--model', 'cate', '--disable-web-search', ...args]
      break
    }
    default: throw new Error('This agent does not support custom API providers.')
  }
  return { command: { ...command, args }, env }
}
