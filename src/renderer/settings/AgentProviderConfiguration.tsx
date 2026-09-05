import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ArrowClockwise, CaretRight, Plus } from '@phosphor-icons/react'
import { inputCls } from '../ui/Modal'
import { SettingRow, Toggle, TextInput, Select, SecondaryButton } from './SettingsComponents'
import { useSettingsSearch } from './SettingsSearchContext'
import { LoadingState } from '../ui/Spinner'
import { getAgentLogo } from '../lib/agent/agentLogos'
import { T3_AGENTS } from '../../shared/agents'
import { agentProductCopy, providerUpdateFeedback } from './providerUpdateFeedback'

const drivers: string[] = T3_AGENTS.map((agent) => agent.t3.driverId)
const names: Record<string, string> = Object.fromEntries(T3_AGENTS.map((agent) => [agent.t3.driverId, agent.displayName]))
const fields: Record<string, Array<[string, string]>> = {
  codex: [['binaryPath', 'Binary path'], ['homePath', 'CODEX_HOME path'], ['shadowHomePath', 'Shadow home path'], ['launchArgs', 'Launch arguments']],
  claudeAgent: [['binaryPath', 'Binary path'], ['homePath', 'CLAUDE_CONFIG_DIR path'], ['launchArgs', 'Launch arguments'], ['autoCompactWindow', 'Auto-compact after (tokens)']],
  cursor: [['binaryPath', 'Binary path'], ['apiEndpoint', 'API endpoint']],
  grok: [['binaryPath', 'Binary path']],
  opencode: [['binaryPath', 'Binary path'], ['serverUrl', 'Server URL'], ['serverPassword', 'Server password']],
}
interface Instance {
  driver: string
  displayName?: string
  accentColor?: string
  enabled?: boolean
  environment?: Array<{ name: string; value: string; sensitive: boolean; valueRedacted?: boolean }>
  config?: Record<string, any>
}

function SettingsDisclosure({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  const { query } = useSettingsSearch()
  return <details key={query} open={query ? true : undefined} className="group rounded-lg border border-subtle bg-surface-1">
    <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg px-4 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-blue [&::-webkit-details-marker]:hidden">
      <CaretRight size={14} className="shrink-0 text-muted group-open:rotate-90" />
      <span>
        <span className="block text-sm font-medium text-primary">{title}</span>
        <span className="mt-0.5 block text-xs text-muted">{description}</span>
      </span>
    </summary>
    <div className="border-t border-subtle px-4 pb-3">{children}</div>
  </details>
}

export function AgentProviderConfiguration({ workspaceId, cwd, onChanged, authentication }: {
  workspaceId: string; cwd: string; onChanged: () => Promise<void>; authentication: (driver: string) => ReactNode
}) {
  const [settings, setSettings] = useState<Record<string, any> | null>(null)
  const [providers, setProviders] = useState<Array<Record<string, any>>>([])
  const [selected, setSelected] = useState('codex')
  const [draft, setDraft] = useState<Instance | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [newDriver, setNewDriver] = useState('codex')
  const [dirty, setDirty] = useState(false)
  const operate = useCallback(async (operation: 'read' | 'save' | 'refresh' | 'update', extra: Record<string, any> = {}) => {
    if (!cwd || !workspaceId) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await window.electronAPI.agentProviderSettings({ workspaceId, cwd, operation, ...extra })
      if ('error' in result) throw new Error(result.error)
      setSettings(result.settings); setProviders(result.providers)
      if (operation !== 'read') await onChanged()
      if (operation === 'save') { setDirty(false); setMessage('Settings saved.') }
      if (operation === 'update') {
        const updated = result.providers.find((p) => p.instanceId === extra.instanceId)
        const feedback = providerUpdateFeedback(updated)
        if (feedback.error) setError(feedback.message)
        else setMessage(feedback.message)
      }
    } catch (cause) { setError(agentProductCopy(cause instanceof Error ? cause.message : 'Provider operation failed.')) }
    finally { setBusy(false) }
  }, [cwd, workspaceId, onChanged])
  useEffect(() => { void operate('read') }, [operate])
  const instances: Record<string, Instance> = {
    ...Object.fromEntries(drivers.map((driver) => [driver, {
      driver, enabled: settings?.providers?.[driver]?.enabled ?? true,
      config: settings?.providers?.[driver] ?? {},
    }])),
    ...settings?.providerInstances,
  }
  useEffect(() => {
    if (!settings || dirty) return
    const existing = settings.providerInstances?.[selected]
    setDraft(existing ?? { driver: selected, enabled: settings.providers?.[selected]?.enabled ?? true, config: settings.providers?.[selected] ?? {} })
  }, [settings, selected, dirty])
  const edit = (patch: Partial<Instance>) => { setDraft((current) => current ? { ...current, ...patch } : current); setDirty(true) }
  const editConfig = (key: string, value: unknown) => edit({ config: { ...draft?.config, [key]: value } })
  const snapshot = providers.find((provider) => provider.instanceId === selected)
  const save = () => {
    if (!draft || !settings) return
    void operate('save', { patch: {
      ...(drivers.includes(selected) ? { providers: { [selected]: { ...draft.config, customModels: (draft.config?.customModels ?? []).filter((model: string) => model.trim()), enabled: draft.enabled } } } : {}),
      providerInstances: { ...settings.providerInstances, [selected]: { ...draft, config: {
        ...draft.config, customModels: (draft.config?.customModels ?? []).filter((model: string) => model.trim()),
      } } },
    } })
  }
  if (!cwd) return <p className="text-xs text-muted">Open a workspace to configure T3 Code providers.</p>
  return <div className="flex flex-col gap-4" data-agent-native-settings>
    <SettingRow label="T3 Code providers" description="Manage which providers are available in chats and configure each account.">
      <SecondaryButton disabled={busy || dirty} onClick={() => void operate('refresh')}><ArrowClockwise size={14} />Refresh</SecondaryButton>
    </SettingRow>
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    {message && <p role="status" className="text-xs text-secondary">{message}</p>}
    {busy && <LoadingState label="Updating T3 Code providers…" size={14} />}
    {settings && draft && <>
      <fieldset disabled={busy || dirty}>
        <legend className="text-sm font-medium text-primary">Provider to configure</legend>
        <p className="mt-1 text-xs text-muted">Selection only changes the settings shown below. Choose the provider for a conversation in the chat.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {Object.entries(instances).map(([id, instance]) => {
            const label = instance.displayName || (drivers.includes(id) ? names[instance.driver] : `${names[instance.driver] || instance.driver} · ${id}`)
            const logo = getAgentLogo(names[instance.driver])
            return <button
              key={id}
              type="button"
              aria-label={`Configure ${label}`}
              aria-pressed={selected === id}
              onClick={() => setSelected(id)}
              className={`flex min-w-20 flex-1 flex-col items-center justify-center gap-2 rounded-lg border px-3 py-3 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-blue disabled:cursor-default disabled:opacity-50 ${selected === id ? 'border-focus-blue bg-focus-blue/10 text-primary' : 'border-subtle bg-surface-1 text-muted hover:bg-hover hover:text-primary'}`}
            >
              {logo && <img src={logo} alt="" draggable={false} className="h-6 w-6 shrink-0 object-contain" />}
              <span className="max-w-36 truncate">{label}</span>
            </button>
          })}
        </div>
      </fieldset>
      <fieldset key={selected} disabled={busy} className="flex min-w-0 flex-col gap-3 rounded-xl border border-subtle bg-surface-0 p-4">
        <div className="border-b border-subtle pb-3">
          <p className="text-xs text-muted">Provider settings</p>
          <h3 className="mt-1 text-base font-semibold text-primary">{draft.displayName || (drivers.includes(selected) ? names[draft.driver] : `${names[draft.driver] || draft.driver} · ${selected}`)}</h3>
        </div>
        <SettingRow label="Available in chats" description="Show this provider in the chat provider picker.">
          <Toggle checked={draft.enabled !== false} onChange={(enabled) => edit({ enabled, config: { ...draft.config, enabled } })} />
        </SettingRow>
        <div className="py-3">{drivers.includes(selected) ? authentication(draft.driver) : <p className="text-xs text-muted">Configure this account through its environment variables in Advanced provider settings.</p>}</div>
        {snapshot?.versionAdvisory?.canUpdate && <div><SecondaryButton onClick={() => void operate('update', { provider: draft.driver, instanceId: selected })} disabled={dirty}>Update provider</SecondaryButton></div>}
        <SettingsDisclosure title="Advanced provider settings" description="Display name, custom models, CLI paths, and environment variables.">
          <SettingRow label="Display name"><TextInput value={draft.displayName ?? ''} onChange={(value) => edit({ displayName: value || undefined })} /></SettingRow>
          <SettingRow label="Accent color"><TextInput placeholder="#3b82f6" value={draft.accentColor || '#3b82f6'} onChange={(accentColor) => edit({ accentColor })} /></SettingRow>
          {(fields[draft.driver] ?? []).map(([key, label]) => <SettingRow key={key} label={label} description={key === 'launchArgs' ? 'One argument per line.' : undefined}>
            {key === 'launchArgs'
              ? <textarea aria-label={label} className={inputCls} value={Array.isArray(draft.config?.[key]) ? draft.config[key].join('\n') : draft.config?.[key] ?? ''} onChange={(e) => editConfig(key, e.target.value)} />
              : <TextInput type={key === 'serverPassword' ? 'password' : 'text'} value={String(draft.config?.[key] ?? '')} onChange={(value) => editConfig(key, key === 'autoCompactWindow' ? value ? Number(value) : undefined : value)} />}
          </SettingRow>)}
          <SettingRow label="Custom models" description={`One per line. Available: ${(snapshot?.models ?? []).map((model: any) => model.name || model.id).join(', ') || 'No models reported yet.'}`}>
            <textarea aria-label="Custom models" className={inputCls} value={(draft.config?.customModels ?? []).join('\n')} onChange={(e) => editConfig('customModels', e.target.value.split('\n'))} />
          </SettingRow>
          <h3 className="mt-4 text-sm font-medium text-primary">Environment variables</h3>
          <p className="text-xs text-muted">Values apply to this T3 instance. Secret values remain hidden after saving.</p>
          {(draft.environment ?? []).map((entry, index) => <div key={index} className="border-b border-subtle py-2">
            <SettingRow label={`Variable name ${index + 1}`}><TextInput value={entry.name} onChange={(name) => edit({ environment: draft.environment!.map((item, i) => i === index ? { ...item, name } : item) })} /></SettingRow>
            <SettingRow label={`Variable value ${index + 1}`}><TextInput type={entry.sensitive ? 'password' : 'text'} value={entry.value} placeholder={entry.valueRedacted ? 'Stored securely' : 'Value'} onChange={(value) => edit({ environment: draft.environment!.map((item, i) => i === index ? { ...item, value, valueRedacted: false } : item) })} /></SettingRow>
            <SettingRow label={`Secret ${index + 1}`}><Toggle checked={entry.sensitive} onChange={(sensitive) => edit({ environment: draft.environment!.map((item, i) => i === index ? { ...item, sensitive } : item) })} /></SettingRow>
            <SecondaryButton onClick={() => edit({ environment: draft.environment!.filter((_, i) => i !== index) })}>Remove variable</SecondaryButton>
          </div>)}
          <div className="py-2"><SecondaryButton onClick={() => edit({ environment: [...draft.environment ?? [], { name: '', value: '', sensitive: true }] })}>Add variable</SecondaryButton></div>
        </SettingsDisclosure>
        {dirty && <SettingRow label="Unsaved changes" description="Save or discard before selecting another provider."><div className="flex gap-2"><SecondaryButton onClick={() => setDirty(false)}>Discard</SecondaryButton><SecondaryButton onClick={save}>Save provider</SecondaryButton></div></SettingRow>}
      </fieldset>
      <fieldset disabled={busy || dirty} className="flex min-w-0 flex-col gap-3">
        <SettingsDisclosure title="Additional provider accounts" description="Set up another account or endpoint for a provider.">
          <SettingRow label="Provider type" description="Creates a separate configuration you can select above."><div className="flex gap-2"><Select value={newDriver} onChange={setNewDriver} options={drivers.map((value) => ({ value, label: names[value] }))} /><SecondaryButton onClick={() => {
            const id = `${newDriver}-${crypto.randomUUID().slice(0, 8)}`
            void operate('save', { patch: { providerInstances: { ...settings.providerInstances, [id]: { driver: newDriver, enabled: true, config: {} } } } })
          }}><Plus size={13} />Add account</SecondaryButton></div></SettingRow>
          {!drivers.includes(selected) && <SecondaryButton onClick={() => {
            const remaining = { ...settings.providerInstances }; delete remaining[selected]; setSelected('codex')
            void operate('save', { patch: { providerInstances: remaining } })
          }}>Remove selected account</SecondaryButton>}
        </SettingsDisclosure>
        <SettingsDisclosure title="T3 Code preferences" description="Shared across providers. Updates, chat cleanup, and generated titles save immediately.">
          {([['enableProviderUpdateChecks', 'Check for provider updates'], ['enableLegacyTokenStreaming', 'Legacy token streaming'], ['sidebarAutoSettleOnMerge', 'Settle chats after merge']] as const).map(([key, label]) => <SettingRow key={key} label={label}><Toggle checked={!!settings[key]} onChange={(value) => void operate('save', { patch: { [key]: value } })} /></SettingRow>)}
          <SettingRow label="Provider status refresh interval"><Select value={String(settings.providerHealthRefreshInterval ?? 30000)} onChange={(value) => void operate('save', { patch: { providerHealthRefreshInterval: Number(value) } })} options={[15000, 30000, 60000, 300000].map((ms) => ({ value: String(ms), label: `${ms / 1000} seconds` }))} /></SettingRow>
          <SettingRow label="Automatically settle inactive chats"><Select value={String(settings.sidebarAutoSettleAfterDays ?? 'never')} onChange={(value) => void operate('save', { patch: { sidebarAutoSettleAfterDays: value === 'never' ? null : Number(value) } })} options={[{ value: 'never', label: 'Never' }, ...[1, 3, 7, 14, 30].map((days) => ({ value: String(days), label: `After ${days} days` }))]} /></SettingRow>
          <SettingRow label="Model for generated chat titles"><Select value={JSON.stringify([settings.textGenerationModelSelection?.instanceId, settings.textGenerationModelSelection?.model])} onChange={(value) => {
            const [instanceId, model] = JSON.parse(value)
            void operate('save', { patch: { textGenerationModelSelection: { instanceId, model, options: [] } } })
          }} options={[{ value: JSON.stringify([settings.textGenerationModelSelection?.instanceId, settings.textGenerationModelSelection?.model]), label: settings.textGenerationModelSelection?.model ?? 'Default' }, ...providers.flatMap((provider) => (provider.models ?? []).map((model: any) => ({ value: JSON.stringify([provider.instanceId, model.slug]), label: `${provider.displayName || names[provider.driver]} · ${model.name}` })))]} /></SettingRow>
        </SettingsDisclosure>
      </fieldset>
    </>}
  </div>
}
