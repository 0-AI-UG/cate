// =============================================================================
// customModels — Cate-managed OpenAI-compatible providers, persisted to pi's
// models.json.
//
// Like auth.json, the source of truth is one shared file in cate's userData
// that we mirror into each workspace's .cate/pi-agent dir, because the embedded
// pi resolves its config from PI_CODING_AGENT_DIR (per-workspace), not the
// user's global ~/.pi/agent. pi reloads models.json whenever its model list is
// fetched, so a saved endpoint shows up without restarting a session.
//
// We own the legacy `custom-openai` provider key and the `custom-openai-*`
// namespace. Any other providers a user hand-authored in models.json are
// preserved on write.
// =============================================================================

import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { hostAgentDir, hostJoin, PI_AGENT_DIR, type AgentDirVariant } from './agentDir'
import type { Runtime } from '../../main/runtime/types'
import type { CustomOpenAIProvider } from '../../shared/types'
import { readAgentConfigFile, updateAgentConfigFile } from './agentConfigLock'

const LEGACY_PROVIDER_ID = 'custom-openai'
const PROVIDER_ID_PATTERN = /^custom-openai(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/

type ModelEntry = { id?: unknown } & Record<string, unknown>
type ProviderEntry = Record<string, unknown> & { models?: unknown }

function isManagedProviderId(id: string): boolean {
  return PROVIDER_ID_PATTERN.test(id)
}

function requireManagedProviderId(id: string): void {
  if (!isManagedProviderId(id)) {
    throw new Error('Custom provider id must be "custom-openai" or start with "custom-openai-"')
  }
}

/** The shared models.json — source of truth, mirrored into each workspace. */
export function sharedModelsPath(): string {
  return path.join(app.getPath('userData'), PI_AGENT_DIR, 'models.json')
}

/** Read all Cate-managed providers. The original `custom-openai` entry remains
 * addressable under the same id so persisted model references keep working. */
export async function readCustomOpenAIProviders(): Promise<CustomOpenAIProvider[]> {
  const data = await readAgentConfigFile(sharedModelsPath())
  const providers = data?.providers
  if (!providers || typeof providers !== 'object') return []

  const result: CustomOpenAIProvider[] = []
  for (const [id, value] of Object.entries(providers)) {
    if (!isManagedProviderId(id) || !value || typeof value !== 'object') continue
    const entry = value as ProviderEntry
    result.push({
      id,
      name: typeof entry.name === 'string'
        ? entry.name
        : id === LEGACY_PROVIDER_ID ? 'Custom OpenAI endpoint' : id,
      baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
      apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : '',
      models: Array.isArray(entry.models)
        ? entry.models
          .map((model) => (
            model && typeof model === 'object' && typeof (model as ModelEntry).id === 'string'
              ? (model as ModelEntry).id as string
              : ''
          ))
          .filter(Boolean)
        : [],
    })
  }
  return result
}

/** Add or update one managed provider. Unknown provider fields and advanced
 * model fields are retained when the corresponding model id remains present. */
export async function saveCustomOpenAIProvider(cfg: CustomOpenAIProvider): Promise<void> {
  requireManagedProviderId(cfg.id)
  const name = cfg.name.trim()
  const baseUrl = cfg.baseUrl.trim()
  const models = cfg.models.map((id) => id.trim()).filter(Boolean)
  if (!name) throw new Error('Custom provider name is required')
  if (!baseUrl) throw new Error('Custom provider base URL is required')
  if (models.length === 0) throw new Error('Custom provider needs at least one model')

  await updateAgentConfigFile(sharedModelsPath(), (data) => {
    if (!data.providers || typeof data.providers !== 'object') data.providers = {}
    const existing = data.providers[cfg.id]
    const existingEntry = existing && typeof existing === 'object'
      ? existing as ProviderEntry
      : {}
    const existingModels = new Map<string, ModelEntry>()
    if (Array.isArray(existingEntry.models)) {
      for (const model of existingEntry.models) {
        if (model && typeof model === 'object' && typeof (model as ModelEntry).id === 'string') {
          existingModels.set((model as ModelEntry).id as string, model as ModelEntry)
        }
      }
    }

    data.providers[cfg.id] = {
      ...existingEntry,
      name,
      baseUrl,
      api: 'openai-completions',
      // pi requires a non-empty apiKey when models are defined; local servers
      // (Ollama, LM Studio, vLLM) ignore the value, so default to a placeholder.
      apiKey: cfg.apiKey.trim() || 'none',
      models: models.map((id) => existingModels.get(id) ?? { id }),
    }
    return data
  })
}

/** Delete one Cate-managed provider without touching siblings or hand-authored
 * providers outside Cate's reserved id namespace. */
export async function deleteCustomOpenAIProvider(providerId: string): Promise<void> {
  requireManagedProviderId(providerId)
  await updateAgentConfigFile(sharedModelsPath(), (data) => {
    if (data.providers && typeof data.providers === 'object') {
      delete data.providers[providerId]
    }
    return data
  })
}

/** Mirror the shared models.json into the host's pi-agent dir via the runtime
 *  (works local + remote). No-op when the shared file doesn't exist. */
export async function mirrorModelsToWorkspace(runtime: Runtime, hostCwd: string, variant: AgentDirVariant = 'default'): Promise<void> {
  const data = await readAgentConfigFile(sharedModelsPath())
  if (data == null) return
  const dir = hostAgentDir(runtime.id, hostCwd, variant)
  const dest = hostJoin(runtime.id, dir, 'models.json')
  try {
    await runtime.file.mkdir(dir)
    await runtime.file.writeFile(dest, JSON.stringify(data, null, 2) + '\n')
  } catch (err) {
    log.warn('[customModels] mirror to %s failed: %O', dest, err)
  }
}
