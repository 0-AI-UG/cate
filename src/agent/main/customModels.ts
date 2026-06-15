// =============================================================================
// customModels — a single user-defined OpenAI-compatible provider, persisted to
// pi's models.json.
//
// Like auth.json, the source of truth is one shared file in cate's userData
// that we mirror into each workspace's .cate/pi-agent dir, because the embedded
// pi resolves its config from PI_CODING_AGENT_DIR (per-workspace), not the
// user's global ~/.pi/agent. pi reloads models.json whenever its model list is
// fetched, so a saved endpoint shows up without restarting a session.
//
// We own the `custom-openai` provider key only; any other providers a user
// hand-authored in models.json are preserved on write.
// =============================================================================

import fsp from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { writeJsonAtomic } from '../../main/writeJsonAtomic'
import { hostAgentDir, hostJoin, PI_AGENT_DIR } from './agentDir'
import type { Companion } from '../../main/companion/types'
import type { CustomOpenAIProvider } from '../../shared/types'

const PROVIDER_ID = 'custom-openai'

/** The shared models.json — source of truth, mirrored into each workspace. */
export function sharedModelsPath(): string {
  return path.join(app.getPath('userData'), PI_AGENT_DIR, 'models.json')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(p: string): Promise<Record<string, any> | null> {
  try { return JSON.parse(await fsp.readFile(p, 'utf-8')) }
  catch { return null }
}

/** Read the configured custom OpenAI provider, or null when none is set. */
export async function readCustomOpenAI(): Promise<CustomOpenAIProvider | null> {
  const data = await readJson(sharedModelsPath())
  const entry = data?.providers?.[PROVIDER_ID]
  if (!entry) return null
  return {
    baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
    apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : '',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    models: Array.isArray(entry.models)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? entry.models.map((m: any) => (typeof m?.id === 'string' ? m.id : '')).filter(Boolean)
      : [],
  }
}

/** Write (or clear, when cfg is null/empty) the custom provider, preserving any
 *  other providers in models.json. */
export async function saveCustomOpenAI(cfg: CustomOpenAIProvider | null): Promise<void> {
  const shared = sharedModelsPath()
  const data = (await readJson(shared)) ?? {}
  if (!data.providers || typeof data.providers !== 'object') data.providers = {}

  if (!cfg || !cfg.baseUrl.trim() || cfg.models.length === 0) {
    delete data.providers[PROVIDER_ID]
  } else {
    data.providers[PROVIDER_ID] = {
      baseUrl: cfg.baseUrl.trim(),
      api: 'openai-completions',
      // pi requires a non-empty apiKey when models are defined; local servers
      // (Ollama, LM Studio, vLLM) ignore the value, so default to a placeholder.
      apiKey: cfg.apiKey.trim() || 'none',
      models: cfg.models.map((id) => ({ id })),
    }
  }

  // models.json sits beside auth.json under the pi-agent dir, so write it with
  // the same secret-mode dir (0700) the credentials store uses.
  await writeJsonAtomic(shared, data, { mode: 0o600 })
}

/** Mirror the shared models.json into the host's pi-agent dir via the companion
 *  (works local + remote). No-op when the shared file doesn't exist. */
export async function mirrorModelsToWorkspace(companion: Companion, hostCwd: string): Promise<void> {
  const data = await readJson(sharedModelsPath())
  if (data == null) return
  const dir = hostAgentDir(companion.id, hostCwd)
  const dest = hostJoin(companion.id, dir, 'models.json')
  try {
    await companion.file.mkdir(dir)
    await companion.file.writeFile(dest, JSON.stringify(data, null, 2) + '\n')
  } catch (err) {
    log.warn('[customModels] mirror to %s failed: %O', dest, err)
  }
}
