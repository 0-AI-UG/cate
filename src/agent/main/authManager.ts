// =============================================================================
// AuthManager — provider auth for the embedded pi coding agent.
//
// Two provider kinds, both persisted to the shared auth.json (the same file
// each workspace's pi RPC process reads, mirrored in by agentDir):
//   - OAuth (anthropic, openai-codex, github-copilot) — { type: 'oauth', ... }
//   - API-key (openai, google, groq, etc.) — { type: 'api_key', key }
//
// Provider logins are not project-specific, so this file is global: one shared
// auth.json under cate's userData (see agentDir.sharedAuthPath). After any write
// we fire `onChange` so AgentManager can push the update into open workspaces.
//
// NOTE: This module imports from pi-ai (pure ESM). electron-vite should handle
// this for us — if it can't, the import line below is the place to look.
// =============================================================================

import { shell, type WebContents } from 'electron'
import fsp from 'fs/promises'
import path from 'path'
import {
  findEnvKeys,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
} from '@earendil-works/pi-ai'
import { getOAuthProvider, getOAuthProviders } from '@earendil-works/pi-ai/oauth'
import { sharedAuthPath } from './agentDir'
import log from '../../main/logger'
import type {
  AuthProviderDescriptor,
  AuthProviderStatus,
  OAuthFlowEvent,
} from '../../shared/types'
import { AUTH_OAUTH_EVENT } from '../../shared/ipc-channels'

// ---------------------------------------------------------------------------
// On-disk auth.json shape (mirrors pi's AuthStorageData)
// ---------------------------------------------------------------------------

type AuthCredentialOnDisk =
  | { type: 'api_key'; key: string }
  | ({ type: 'oauth' } & OAuthCredentials)

type AuthStorageData = Record<string, AuthCredentialOnDisk>

/** Shared with the pi coding-agent CLI we spawn over RPC (mirrored into each
 *  workspace's pi-agent dir by agentDir). */
function authJsonPath(): string {
  return sharedAuthPath()
}

async function readAuthJson(): Promise<AuthStorageData> {
  try {
    const raw = await fsp.readFile(authJsonPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AuthStorageData
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('[authManager] failed to read auth.json: %O', err)
    }
  }
  return {}
}

let writeQueue: Promise<void> = Promise.resolve()
function serializeWrite(fn: () => Promise<void>): Promise<void> {
  writeQueue = writeQueue.then(fn, fn)
  return writeQueue
}

// Fired after every successful write so AgentManager can mirror the shared
// auth.json into open workspaces' pi-agent dirs.
let onAuthChange: (() => void) | null = null

async function writeAuthJson(data: AuthStorageData): Promise<void> {
  await serializeWrite(async () => {
    const p = authJsonPath()
    await fsp.mkdir(path.dirname(p), { recursive: true, mode: 0o700 })
    const tmp = p + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
    try { await fsp.chmod(tmp, 0o600) } catch { /* noop on platforms without modes */ }
    await fsp.rename(tmp, p)
  })
  try { onAuthChange?.() } catch (err) { log.warn('[authManager] onChange hook failed: %O', err) }
}

// ---------------------------------------------------------------------------
// Built-in provider catalog
// ---------------------------------------------------------------------------

interface BuiltInApiKeyProvider {
  id: string
  name: string
  envVar: string
  helpUrl?: string
}

/** Built-in API-key providers recognised by pi-ai. Order = UI order. The id
 *  must match pi-ai's `KnownProvider` union so credentials in auth.json are
 *  picked up by the spawned pi process. */
const BUILTIN_API_KEY_PROVIDERS: BuiltInApiKeyProvider[] = [
  { id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', helpUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Anthropic (API key)', envVar: 'ANTHROPIC_API_KEY', helpUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openrouter', name: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', helpUrl: 'https://openrouter.ai/keys' },
  { id: 'google', name: 'Google Gemini', envVar: 'GEMINI_API_KEY', helpUrl: 'https://aistudio.google.com/app/apikey' },
  { id: 'groq', name: 'Groq', envVar: 'GROQ_API_KEY', helpUrl: 'https://console.groq.com/keys' },
  { id: 'xai', name: 'xAI', envVar: 'XAI_API_KEY', helpUrl: 'https://x.ai/api' },
  { id: 'mistral', name: 'Mistral', envVar: 'MISTRAL_API_KEY', helpUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'deepseek', name: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY', helpUrl: 'https://platform.deepseek.com' },
  { id: 'moonshotai', name: 'Moonshot (Kimi)', envVar: 'MOONSHOT_API_KEY', helpUrl: 'https://platform.moonshot.ai' },
  { id: 'zai', name: 'z.ai (Zhipu)', envVar: 'ZAI_API_KEY', helpUrl: 'https://z.ai' },
  { id: 'minimax', name: 'MiniMax', envVar: 'MINIMAX_API_KEY', helpUrl: 'https://www.minimax.io' },
  { id: 'cerebras', name: 'Cerebras', envVar: 'CEREBRAS_API_KEY', helpUrl: 'https://cloud.cerebras.ai' },
  { id: 'together', name: 'Together', envVar: 'TOGETHER_API_KEY', helpUrl: 'https://api.together.xyz' },
  { id: 'fireworks', name: 'Fireworks', envVar: 'FIREWORKS_API_KEY', helpUrl: 'https://fireworks.ai' },
  { id: 'huggingface', name: 'HuggingFace', envVar: 'HF_TOKEN', helpUrl: 'https://huggingface.co/settings/tokens' },
  { id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI', envVar: 'CLOUDFLARE_API_KEY', helpUrl: 'https://developers.cloudflare.com/workers-ai/' },
  { id: 'vercel-ai-gateway', name: 'Vercel AI Gateway', envVar: 'AI_GATEWAY_API_KEY', helpUrl: 'https://vercel.com/ai-gateway' },
]

// ---------------------------------------------------------------------------
// AuthManager
// ---------------------------------------------------------------------------

interface PendingOAuthPrompt {
  resolve: (value: string) => void
  reject: (err: Error) => void
}

export class AuthManager {
  private pendingPrompts = new Map<string, PendingOAuthPrompt>()
  private activeFlows = new Set<string>()
  /** Per-providerId connectedAt timestamps (iso). */
  private connectedAt = new Map<string, string>()

  /** Register a callback fired after any credential write — used by
   *  AgentManager to push the shared auth.json into open workspaces. */
  setOnChange(fn: () => void): void {
    onAuthChange = fn
  }

  async listProviders(): Promise<AuthProviderDescriptor[]> {
    const oauth: AuthProviderDescriptor[] = []
    for (const p of getOAuthProviders()) {
      oauth.push({
        id: p.id,
        name: p.name,
        kind: 'oauth',
        usesCallbackServer: p.usesCallbackServer === true,
      })
    }
    const apiKey: AuthProviderDescriptor[] = BUILTIN_API_KEY_PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      kind: 'apiKey',
      envVar: p.envVar,
      helpUrl: p.helpUrl,
    }))
    return [...oauth, ...apiKey]
  }

  async status(): Promise<AuthProviderStatus[]> {
    const result: AuthProviderStatus[] = []
    const authData = await readAuthJson()

    // OAuth providers
    for (const p of getOAuthProviders()) {
      const cred = authData[p.id]
      const connected = cred?.type === 'oauth'
      result.push({
        id: p.id,
        connected,
        source: connected ? 'oauth' : undefined,
        connectedAt: connected ? this.connectedAt.get(p.id) : undefined,
      })
    }

    // Built-in API-key providers (auth.json + env vars)
    for (const p of BUILTIN_API_KEY_PROVIDERS) {
      const hasAuthJson = authData[p.id]?.type === 'api_key'
      const hasEnv = !!findEnvKeys(p.id)
      const connected = hasAuthJson || hasEnv
      result.push({
        id: p.id,
        connected,
        source: hasAuthJson ? 'safeStorage' : hasEnv ? 'env' : undefined,
        connectedAt: connected ? this.connectedAt.get(p.id) : undefined,
      })
    }

    return result
  }

  // -------------------------------------------------------------------------
  // OAuth flow
  // -------------------------------------------------------------------------

  /** Cancel any in-flight OAuth flow for this provider — rejects pending
   *  prompts so pi-ai's awaiter unblocks and the local callback server closes
   *  via the `finally` in startOAuth. */
  cancelOAuth(providerId: string): void {
    for (const [pid, p] of this.pendingPrompts) {
      if (pid.startsWith(`oauth-${providerId}-`)) {
        p.reject(new Error('OAuth flow cancelled'))
        this.pendingPrompts.delete(pid)
      }
    }
    this.activeFlows.delete(providerId)
  }

  async startOAuth(providerId: string, sender: WebContents): Promise<void> {
    const provider = getOAuthProvider(providerId)
    if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`)
    // If a previous flow is still pending (e.g. user navigated away without
    // completing it), cancel it first so the user can retry without hitting
    // "already in progress". The previous flow's pi-ai promise will reject
    // through the rejected prompt, and the `finally` block will free port 1455
    // and the activeFlows entry.
    if (this.activeFlows.has(providerId)) {
      this.cancelOAuth(providerId)
      // Give the previous flow's `finally` a tick to close the HTTP server
      // bound to port 1455 before we try to bind it again.
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    this.activeFlows.add(providerId)

    const send = (event: OAuthFlowEvent): void => {
      try {
        if (!sender.isDestroyed()) sender.send(AUTH_OAUTH_EVENT, providerId, event)
      } catch (err) {
        log.warn('[authManager] failed to send oauth event: %O', err)
      }
    }

    const newPromptId = (): string => `oauth-${providerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const awaitPrompt = (promptId: string): Promise<string> => {
      return new Promise<string>((resolve, reject) => {
        this.pendingPrompts.set(promptId, { resolve, reject })
      })
    }

    const callbacks: OAuthLoginCallbacks = {
      onAuth: ({ url, instructions }: { url: string; instructions?: string }) => {
        send({ type: 'auth', url, instructions })
        // pi-ai hands us the URL but never opens a browser — that's our job.
        // Without this the user just sees an empty "Paste the code" form,
        // because the auth event is immediately followed by onManualCodeInput
        // in anthropic/openai-codex flows.
        shell.openExternal(url).catch((err) => {
          log.warn('[authManager] shell.openExternal failed for %s: %O', providerId, err)
        })
      },
      onDeviceCode: ({ userCode, verificationUri, intervalSeconds, expiresInSeconds }) => {
        send({ type: 'deviceCode', userCode, verificationUri, intervalSeconds, expiresInSeconds })
        shell.openExternal(verificationUri).catch((err) => {
          log.warn('[authManager] shell.openExternal failed for %s: %O', providerId, err)
        })
      },
      onProgress: (message: string) => {
        send({ type: 'progress', message })
      },
      onPrompt: async (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => {
        const promptId = newPromptId()
        send({
          type: 'prompt',
          promptId,
          message: prompt.message,
          placeholder: prompt.placeholder,
          allowEmpty: prompt.allowEmpty,
        })
        return await awaitPrompt(promptId)
      },
      onSelect: async (prompt: { message: string; options: Array<{ id: string; label: string }> }) => {
        const promptId = newPromptId()
        send({
          type: 'select',
          promptId,
          message: prompt.message,
          options: prompt.options,
        })
        const value = await awaitPrompt(promptId)
        return value || undefined
      },
      onManualCodeInput: async () => {
        const promptId = newPromptId()
        send({ type: 'manualCode', promptId })
        return await awaitPrompt(promptId)
      },
    }

    try {
      const credentials = await provider.login(callbacks)
      const current = await readAuthJson()
      current[providerId] = { type: 'oauth', ...credentials }
      await writeAuthJson(current)
      this.connectedAt.set(providerId, new Date().toISOString())
      send({ type: 'done' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('[authManager] OAuth flow failed for %s: %s', providerId, message)
      send({ type: 'error', message })
      throw err instanceof Error ? err : new Error(message)
    } finally {
      // Reject any unresolved prompts so awaiters don't hang.
      for (const [pid, p] of this.pendingPrompts) {
        if (pid.startsWith(`oauth-${providerId}-`)) {
          p.reject(new Error('OAuth flow ended before prompt was answered'))
          this.pendingPrompts.delete(pid)
        }
      }
      this.activeFlows.delete(providerId)
    }
  }

  handlePromptReply(promptId: string, value: string | null): void {
    const pending = this.pendingPrompts.get(promptId)
    if (!pending) {
      log.warn('[authManager] no pending prompt for id %s', promptId)
      return
    }
    this.pendingPrompts.delete(promptId)
    if (value == null) {
      pending.reject(new Error('Prompt cancelled by user'))
    } else {
      pending.resolve(value)
    }
  }

  // -------------------------------------------------------------------------
  // API key management
  // -------------------------------------------------------------------------

  async saveApiKey(providerId: string, key: string): Promise<void> {
    const current = await readAuthJson()
    current[providerId] = { type: 'api_key', key }
    await writeAuthJson(current)
    this.connectedAt.set(providerId, new Date().toISOString())
  }

  async deleteProvider(providerId: string): Promise<void> {
    const auth = await readAuthJson()
    if (providerId in auth) {
      delete auth[providerId]
      await writeAuthJson(auth)
    }
    this.connectedAt.delete(providerId)
  }

  // -------------------------------------------------------------------------
}

// Single shared instance — main process is one per app.
export const authManager = new AuthManager()
