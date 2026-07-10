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
import {
  findEnvKeys,
  getEnvApiKey,
  getModels,
  getProviders,
  type KnownProvider,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
} from '@earendil-works/pi-ai'
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from '@earendil-works/pi-ai/oauth'
import { sharedAuthPath } from './agentDir'
import { agentConfigLock } from './agentConfigLock'
import { readCustomOpenAI } from './customModels'
import log from '../../main/logger'
import { isPlainObject } from '../../main/jsonUtils'
import { writeJsonAtomic } from '../../main/writeJsonAtomic'
import type {
  AgentModelDescriptor,
  AuthProviderDescriptor,
  AuthProviderStatus,
  OAuthFlowEvent,
  ProviderVerification,
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
    if (isPlainObject(parsed)) {
      return parsed as AuthStorageData
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('[authManager] failed to read auth.json: %O', err)
    }
  }
  return {}
}

// Fired after every successful write so AgentManager can mirror the shared
// auth.json into open workspaces' pi-agent dirs.
let onAuthChange: (() => void) | null = null

async function writeAuthJson(data: AuthStorageData): Promise<void> {
  await agentConfigLock.run('auth.json', async () => {
    await writeJsonAtomic(authJsonPath(), data, { mode: 0o600 })
  })
  try { onAuthChange?.() } catch (err) { log.warn('[authManager] onChange hook failed: %O', err) }
}

// ---------------------------------------------------------------------------
// Built-in provider catalog
// ---------------------------------------------------------------------------

const PROVIDER_META: Record<string, Pick<AuthProviderDescriptor, 'name' | 'helpUrl'>> = {
  openai: { name: 'OpenAI', helpUrl: 'https://platform.openai.com/api-keys' },
  anthropic: { name: 'Anthropic (API key)', helpUrl: 'https://console.anthropic.com/settings/keys' },
  openrouter: { name: 'OpenRouter', helpUrl: 'https://openrouter.ai/keys' },
  google: { name: 'Google Gemini', helpUrl: 'https://aistudio.google.com/app/apikey' },
  groq: { name: 'Groq', helpUrl: 'https://console.groq.com/keys' },
  xai: { name: 'xAI', helpUrl: 'https://x.ai/api' },
  mistral: { name: 'Mistral', helpUrl: 'https://console.mistral.ai/api-keys' },
  deepseek: { name: 'DeepSeek', helpUrl: 'https://platform.deepseek.com' },
  moonshotai: { name: 'Moonshot (Kimi)', helpUrl: 'https://platform.moonshot.ai' },
  zai: { name: 'z.ai (Zhipu)', helpUrl: 'https://z.ai' },
  minimax: { name: 'MiniMax', helpUrl: 'https://www.minimax.io' },
  cerebras: { name: 'Cerebras', helpUrl: 'https://cloud.cerebras.ai' },
  together: { name: 'Together AI', helpUrl: 'https://api.together.xyz' },
  fireworks: { name: 'Fireworks', helpUrl: 'https://fireworks.ai' },
  huggingface: { name: 'Hugging Face', helpUrl: 'https://huggingface.co/settings/tokens' },
  'cloudflare-workers-ai': { name: 'Cloudflare Workers AI', helpUrl: 'https://developers.cloudflare.com/workers-ai/' },
  'vercel-ai-gateway': { name: 'Vercel AI Gateway', helpUrl: 'https://vercel.com/ai-gateway' },
}

const NON_API_KEY_PROVIDERS = new Set(['amazon-bedrock', 'openai-codex'])

function providerName(id: string): string {
  return PROVIDER_META[id]?.name ?? id
    .split('-')
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ')
}

/** pi-ai owns the provider id catalog. Cate contributes display/help metadata
 *  only, so upgrading pi cannot leave the UI on a stale provider fork. */
function apiKeyProviders(): AuthProviderDescriptor[] {
  return getProviders()
    .filter((id) => !NON_API_KEY_PROVIDERS.has(id))
    .map((id) => ({
      id,
      name: providerName(id),
      kind: 'apiKey' as const,
      helpUrl: PROVIDER_META[id]?.helpUrl,
    }))
}

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
    const apiKey = apiKeyProviders()
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
    for (const p of apiKeyProviders()) {
      const hasAuthJson = authData[p.id]?.type === 'api_key'
      const hasEnv = !!getEnvApiKey(p.id)
      const connected = hasAuthJson || hasEnv
      result.push({
        id: p.id,
        connected,
        source: hasAuthJson ? 'config' : hasEnv ? 'env' : undefined,
        connectedAt: connected ? this.connectedAt.get(p.id) : undefined,
      })
    }

    // Custom OpenAI-compatible endpoint (lives in models.json, not auth.json).
    // Connected once a baseUrl and at least one model are configured — the key
    // is optional since local servers (Ollama, LM Studio, vLLM) ignore it.
    const custom = await readCustomOpenAI()
    const customConnected = !!custom && !!custom.baseUrl && custom.models.length > 0
    result.push({
      id: 'custom-openai',
      connected: customConnected,
      source: customConnected ? 'config' : undefined,
      connectedAt: customConnected ? this.connectedAt.get('custom-openai') : undefined,
    })

    return result
  }

  /** The models the user can pick right now, derived purely from persisted
   *  state — connected providers in auth.json (or env keys) crossed with pi's
   *  static model catalog, plus the custom OpenAI endpoint's models from
   *  models.json. No running pi session required, so the same list backs the
   *  agent panel's picker and the Settings → Providers default-model dropdown. */
  async listAvailableModels(): Promise<AgentModelDescriptor[]> {
    const statuses = await this.status()
    const connected = new Set(statuses.filter((s) => s.connected).map((s) => s.id))

    const out: AgentModelDescriptor[] = []
    const seen = new Set<string>() // `${provider}:${id}` — OAuth + API-key share ids

    for (const providerId of connected) {
      if (providerId === 'custom-openai') continue
      // getModels indexes a static catalog and returns [] for unknown ids, so
      // the cast is safe even for providers pi doesn't recognise.
      for (const m of getModels(providerId as KnownProvider)) {
        const key = `${m.provider}:${m.id}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          provider: m.provider,
          id: m.id,
          label: m.name ?? m.id,
          contextWindow: m.contextWindow ?? 0,
          reasoning: m.reasoning ?? false,
        })
      }
    }

    if (connected.has('custom-openai')) {
      const custom = await readCustomOpenAI()
      for (const id of custom?.models ?? []) {
        const key = `custom-openai:${id}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ provider: 'custom-openai', id, label: id, contextWindow: 0, reasoning: false })
      }
    }

    return out
  }

  // -------------------------------------------------------------------------
  // Verification — is the credential usable right now?
  //
  // status() is presence-only. verify() adds the one check that presence can't
  // give: whether an OAuth token can still be minted, or whether the user must
  // re-authenticate. This lives in main because OAuth login/refresh already does
  // (it drives the browser + local callback) — it is NOT model inference.
  //
  // We deliberately do NOT make a live model request here: inference runs through
  // the runtime (pi, local or remote — see AgentManager), never the desktop
  // process. Whether an API key actually works is proven by the real session on
  // its first turn; here API-key / env / custom-openai credentials are reported
  // by presence.
  // -------------------------------------------------------------------------

  async verify(providerId: string): Promise<ProviderVerification> {
    const auth = await readAuthJson()
    const cred = auth[providerId]

    // OAuth: minting/refreshing the access token IS the reliable test — it proves
    // the refresh token is still valid. A failure here means re-authentication.
    const isOAuthProvider = getOAuthProviders().some((p) => p.id === providerId)
    if (isOAuthProvider) {
      if (cred?.type !== 'oauth') return { id: providerId, health: 'needsReauth' }
      try {
        const res = await getOAuthApiKey(providerId, { [providerId]: cred })
        if (!res) return { id: providerId, health: 'needsReauth' }
        const next = res.newCredentials
        if (next && (next.access !== cred.access || next.expires !== cred.expires)) {
          const fresh = await readAuthJson()
          fresh[providerId] = { type: 'oauth', ...next }
          await writeAuthJson(fresh)
          this.connectedAt.set(providerId, new Date().toISOString())
        }
        return { id: providerId, health: 'ok' }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        log.info('[authManager] OAuth verify needs re-auth for %s: %s', providerId, error)
        return { id: providerId, health: 'needsReauth', error }
      }
    }

    // custom-openai lives in models.json, not auth.json — presence only.
    if (providerId === 'custom-openai') {
      const custom = await readCustomOpenAI()
      const connected = !!custom && !!custom.baseUrl && custom.models.length > 0
      return { id: providerId, health: connected ? 'ok' : 'error' }
    }

    // API-key / env providers: presence only (the runtime session validates the
    // key for real on first use).
    const hasCredential = cred?.type === 'api_key' || !!findEnvKeys(providerId)
    return { id: providerId, health: hasCredential ? 'ok' : 'error' }
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
