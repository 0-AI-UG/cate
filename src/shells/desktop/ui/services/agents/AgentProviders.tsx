import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { AgentApiProtocol, AgentProviderInfo, AgentProviderModel } from '@services/agents/contract'
import { useRuntime } from '../../kernel/rpc'

import { Button, IconButton, SecondaryButton, Select, SettingRow, TextInput } from '../../kernel/interaction'

const protocols = [
  { value: 'messages', label: 'Anthropic Messages' },
  { value: 'responses', label: 'OpenAI Responses' },
  { value: 'chat-completions', label: 'Chat Completions' },
]

/** Provider credentials are write-only; editing leaves the saved key intact. */
export function AgentProviders({ workspaceId, providers }: { workspaceId: string; providers: AgentProviderInfo[] }) {
  const runtime = useRuntime(workspaceId)
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [api, setApi] = useState<AgentApiProtocol>('chat-completions')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<AgentProviderModel[]>([{ id: '' }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = (p?: AgentProviderInfo) => {
    setEditing(p?.id ?? 'new'); setName(p?.name ?? ''); setBaseUrl(p?.baseUrl ?? ''); setApi(p?.api ?? 'chat-completions'); setApiKey(''); setModels(p?.models ?? [{ id: '' }]); setError(null)
  }
  const perform = async (work: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update provider.') }
    finally { setBusy(false) }
  }
  const updateModel = (index: number, patch: Partial<AgentProviderModel>) => setModels((all) => all.map((m, i) => i === index ? { ...m, ...patch } : m))
  return <div className="border-b border-subtle pb-2">
    <SettingRow label="API providers" description="Use your own API key and choose a model for each agent.">
      <SecondaryButton disabled={busy} onClick={() => start()}><Plus size={12} />Add provider</SecondaryButton>
    </SettingRow>
    {providers.map((p) => (
      <SettingRow key={p.id} label={p.name} description={`${protocols.find((protocol) => protocol.value === p.api)?.label ?? p.api}${p.hasKey ? '' : ' · API key needed'}`}>
        <div className="flex items-center gap-1">
          <SecondaryButton aria-label={`Edit ${p.name}`} disabled={busy} onClick={() => start(p)}>Edit</SecondaryButton>
          <IconButton label={`Remove ${p.name}`} tone="danger" disabled={busy} onClick={() => { void perform(async () => {
            await runtime!.agents.providerRemove({ id: p.id })
            if (editing === p.id) { setEditing(null); setApiKey('') }
          }) }}><Trash2 size={14} /></IconButton>
        </div>
      </SettingRow>
    ))}
    {editing && <form className="mt-3 rounded-lg border border-subtle bg-surface-2 px-3" onSubmit={(e) => { e.preventDefault(); void perform(async () => {
      await runtime!.agents.providerSave({ ...(editing !== 'new' ? { id: editing } : {}), name: name.trim(), baseUrl: baseUrl.trim(), api, models: models.map((m) => ({ ...m, id: m.id.trim() })), ...(apiKey ? { apiKey } : {}) })
      setEditing(null); setApiKey('')
    }) }}>
      <div className="-mx-3 border-b border-subtle px-3 py-3">
        <h3 className="text-[13px] font-medium text-primary">{editing === 'new' ? 'New provider' : `Edit ${providers.find((p) => p.id === editing)?.name ?? 'provider'}`}</h3>
      </div>
      <fieldset disabled={busy} className="min-w-0 space-y-3 py-3">
        <fieldset className="min-w-0">
          <legend className="pb-1 text-xs font-medium text-muted">Connection</legend>
          <SettingRow label="Name">
            <TextInput value={name} onChange={setName} placeholder="My provider" />
          </SettingRow>
          <SettingRow label="API protocol">
            <Select value={api} onChange={(value) => setApi(value as AgentApiProtocol)} options={protocols} />
          </SettingRow>
          <SettingRow label="API base URL" description={api === 'messages' ? 'The Anthropic base URL, without /v1.' : 'Include the API path, such as /v1.'}>
            <TextInput value={baseUrl} onChange={setBaseUrl} placeholder={api === 'messages' ? 'https://api.anthropic.com' : 'https://provider.example/v1'} />
          </SettingRow>
          <SettingRow label="API key" description={editing !== 'new' && providers.find((p) => p.id === editing)?.hasKey ? 'Leave blank to keep the saved key.' : undefined}>
            <TextInput type="password" value={apiKey} onChange={setApiKey} placeholder="API key" />
          </SettingRow>
        </fieldset>
        <fieldset className="min-w-0 border-t border-subtle pt-3">
          <legend className="px-1 text-xs font-medium text-muted">Models</legend>
          <SettingRow label="Available models" description="Enter model IDs or load them from the saved provider.">
            <div className="flex items-center gap-2">
              <SecondaryButton onClick={() => setModels((all) => [...all, { id: '' }])}><Plus size={12} />Add model</SecondaryButton>
              <SecondaryButton disabled={editing === 'new'} title={editing === 'new' ? 'Save this provider first to load models.' : undefined} onClick={() => { void perform(async () => {
                const found = await runtime!.agents.providerModels({ id: editing })
                if (!found.length) throw new Error('No models found. Enter a model ID manually.')
                setModels((all) => [...all.filter((m) => m.id.trim()), ...found.filter((m) => !all.some((existing) => existing.id === m.id))])
              }) }}>Load models</SecondaryButton>
            </div>
          </SettingRow>
          {models.map((m, i) => <div key={i} className="mt-2 rounded-md border border-subtle px-3">
            <SettingRow label={`Model ${i + 1} ID`}>
              <div className="flex items-center gap-1">
                <TextInput value={m.id} onChange={(id) => updateModel(i, { id })} placeholder="Model ID" layoutClassName="w-40 px-2" />
                <IconButton label={`Remove model ${i + 1}`} tone="danger" disabled={models.length === 1} onClick={() => setModels((all) => all.filter((_, index) => index !== i))}><Trash2 size={14} /></IconButton>
              </div>
            </SettingRow>
            <details className="pb-2">
              <summary className="cursor-pointer py-1 text-xs text-muted hover:text-primary">Model {i + 1} token limits</summary>
              <div className="pl-3">
                <SettingRow label={`Model ${i + 1} context limit`} description="Optional, in tokens.">
                  <TextInput value={m.maxInputTokens?.toString() ?? ''} onChange={(value) => updateModel(i, { maxInputTokens: value ? Number(value) : undefined })} placeholder="Default" layoutClassName="w-24 px-2" />
                </SettingRow>
                <SettingRow label={`Model ${i + 1} output limit`} description="Optional, in tokens.">
                  <TextInput value={m.maxOutputTokens?.toString() ?? ''} onChange={(value) => updateModel(i, { maxOutputTokens: value ? Number(value) : undefined })} placeholder="Default" layoutClassName="w-24 px-2" />
                </SettingRow>
              </div>
            </details>
          </div>)}
        </fieldset>
      </fieldset>
      <div className="-mx-3 flex justify-end gap-2 border-t border-subtle px-3 py-3">
        <SecondaryButton disabled={busy} onClick={() => { setEditing(null); setApiKey('') }}>Cancel</SecondaryButton>
        <Button type="submit" size="sm" variant="primary" loading={busy} loadingLabel="Saving…">Save provider</Button>
      </div>
    </form>}
    {error && <p role="alert" className="py-2 text-xs text-muted">{error}</p>}
  </div>
}
