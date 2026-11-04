import { randomUUID } from 'node:crypto'
import { RpcError } from '@kernel/rpc/contract'
import type { JsonStateFile } from '@kernel/state/node'
import type { SecretsFile } from '@runtime/data/runtime'
import { isAgentProvider, type AgentProvider, type AgentProviderInfo, type AgentProviderSaveRequest, type AgentProviderModel } from '../../contract'
import type { TrustGate } from '../core'

export interface ProviderStore {
  get(): Record<string, AgentProvider>
  set(value: Record<string, AgentProvider>): Promise<void>
}

/** Provider metadata is shared settings; only this runtime reads the keys. */
export function createProviders(deps: { store: ProviderStore; secrets: JsonStateFile<SecretsFile>; trust: TrustGate; fetch?: typeof fetch; changed(): void }) {
  const keys = (): Record<string, string> => {
    const value = deps.secrets.get().agentProviderKeys
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  }
  const publicInfo = (id: string, provider: AgentProvider): AgentProviderInfo => ({ ...provider, id, hasKey: typeof keys()[id] === 'string' })
  const get = (id: string) => {
    const provider = deps.store.get()[id]
    if (!provider || !isAgentProvider(provider)) throw new RpcError('rejected', 'Select a configured API provider in Agents settings.')
    const credential = keys()[id]
    if (typeof credential !== 'string' || !credential) throw new RpcError('rejected', 'Set an API key for this provider in Agents settings.')
    return { provider, credential }
  }
  // Serialize read-modify-write operations across clients.
  let pending = Promise.resolve()
  const mutate = <T>(work: () => Promise<T>): Promise<T> => {
    const result = pending.then(work)
    pending = result.then(() => {}, () => {})
    return result
  }
  return {
    list: () => Object.entries(deps.store.get()).filter(([, p]) => isAgentProvider(p)).map(([id, p]) => publicInfo(id, p)),
    get,
    save(input: AgentProviderSaveRequest) {
      deps.trust.requireTrusted()
      return mutate(async () => {
        const { id: suppliedId, apiKey, ...provider } = input
        const id = suppliedId ?? randomUUID()
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !isAgentProvider(provider)) throw new RpcError('rejected', 'Enter a provider name, HTTPS base URL (or local HTTP), API protocol and valid model IDs and limits.')
        if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey.trim() || /[\x00-\x1f]/.test(apiKey))) throw new RpcError('rejected', 'Enter a valid API key.')
        if (!apiKey && typeof keys()[id] !== 'string') throw new RpcError('rejected', 'Enter an API key for this provider.')
        if (apiKey !== undefined) {
          deps.secrets.update((s) => ({ ...s, agentProviderKeys: { ...keys(), [id]: apiKey.trim() } }))
          await deps.secrets.flushDurable()
        }
        await deps.store.set({ ...deps.store.get(), [id]: provider })
        deps.changed()
        return publicInfo(id, provider)
      })
    },
    remove({ id }: { id: string }) {
      deps.trust.requireTrusted()
      return mutate(async () => {
        const next = { ...deps.store.get() }; delete next[id]
        await deps.store.set(next)
        const remaining = keys(); delete remaining[id]
        deps.secrets.update((s) => ({ ...s, agentProviderKeys: remaining }))
        await deps.secrets.flushDurable()
        deps.changed()
        return { ok: true as const }
      })
    },
    async models({ id }: { id: string }): Promise<AgentProviderModel[]> {
      deps.trust.requireTrusted()
      const { provider, credential } = get(id)
      const base = provider.baseUrl.replace(/\/+$/, '')
      const modelPath = provider.api === 'messages' ? '/v1/models' : '/models'
      const response = await (deps.fetch ?? fetch)(`${base}${modelPath}`, {
        headers: provider.api === 'messages' ? { 'x-api-key': credential, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(15_000), redirect: 'error',
      })
      if (!response.ok) throw new RpcError('rejected', 'This provider could not list models. Enter model IDs manually.')
      const body = await response.json() as { data?: { id?: unknown; name?: unknown; display_name?: unknown }[] }
      if (!Array.isArray(body.data)) throw new RpcError('rejected', 'This provider does not support model discovery. Enter model IDs manually.')
      return body.data.filter((m) => m && typeof m.id === 'string' && m.id.trim() && !/[\x00-\x1f]/.test(m.id)).map((m) => ({ id: m.id as string, ...(typeof (m.name ?? m.display_name) === 'string' ? { name: String(m.name ?? m.display_name) } : {}) }))
    },
  }
}
