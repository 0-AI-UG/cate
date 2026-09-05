import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ArrowClockwise, Check, Plus } from '@phosphor-icons/react'
import { btn, inputCls as baseInputCls } from '../ui/Modal'
import { getAgentLogoById } from '../lib/agent/agentLogos'
import type { AgentId } from '../../shared/agents'
import { agentProductCopy, providerUpdateFeedback } from './providerUpdateFeedback'

const drivers = ['codex', 'claudeAgent', 'cursor', 'grok', 'opencode']
const inputCls = `${baseInputCls} mt-1.5`
const names: Record<string, string> = { codex: 'Codex', claudeAgent: 'Claude', cursor: 'Cursor', grok: 'Grok', opencode: 'OpenCode' }
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
  const [tab, setTab] = useState('Configuration')
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
  if (!cwd) return <p className="text-xs text-muted">Open a workspace to configure its agent providers.</p>
  return <div className="flex flex-col gap-5" data-agent-native-settings>
    <div className="flex items-center justify-between gap-2">
      <div><h3 className="text-base font-medium text-primary">Your providers</h3><p className="mt-1 text-xs text-muted">Connect an account and choose how your agent runs.</p></div>
      <button className={btn.secondary} disabled={busy || dirty} onClick={() => void operate('refresh')}><ArrowClockwise size={14} className={busy ? 'animate-spin' : ''} />Refresh providers</button>
    </div>
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    {message && <p role="status" className="text-xs text-secondary">{message}</p>}
    {busy && <p role="status" className="text-xs text-muted">Working…</p>}
    {settings && draft && <>
      <div role="group" aria-label="Provider instance" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {Object.entries(instances).map(([id, instance]) => {
          const logo = getAgentLogoById((instance.driver === 'claudeAgent' ? 'claude-code' : instance.driver) as AgentId)
          return <button key={id} aria-label={`Select ${instance.displayName || names[instance.driver] || id}`} aria-pressed={selected === id} disabled={dirty || busy} onClick={() => setSelected(id)} className={`relative flex items-center gap-2.5 rounded-lg border px-3 py-3 text-left text-xs transition-colors disabled:opacity-50 ${selected === id ? 'border-focus-blue bg-focus-blue/10 text-primary' : 'border-subtle hover:bg-surface-3 text-secondary'}`}>
            {logo && <img src={logo} alt="" className="h-5 w-5 shrink-0" />}<span className="truncate">{instance.displayName || names[instance.driver]}</span>
          </button>
        })}
      </div>
      <fieldset disabled={busy} className="rounded-xl border border-subtle overflow-hidden min-w-0">
        <div className="flex items-center justify-between gap-3 px-5 py-4 bg-surface-3/50">
          <div><h3 className="text-sm font-medium text-primary">{draft.displayName || names[draft.driver]}</h3><p className="mt-1 text-xs text-muted">{snapshot?.version ? `Version ${snapshot.version}` : 'Provider configuration'}</p></div>
          <label className="flex items-center gap-2 text-xs text-secondary cursor-pointer">Enabled<input className="sr-only peer" type="checkbox" checked={draft.enabled !== false} disabled={busy} onChange={(e) => edit({ enabled: e.target.checked, config: { ...draft.config, enabled: e.target.checked } })} /><span className="relative h-5 w-9 rounded-full bg-surface-6 peer-checked:bg-focus-blue peer-focus-visible:ring-2 ring-focus-blue after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4" /></label>
        </div>
        <div className="px-5 py-4 border-t border-subtle">{drivers.includes(selected) ? authentication(draft.driver) : <p className="text-xs text-muted">Configure credentials for this instance using environment variables below.</p>}</div>
        <div className="px-5 flex flex-col gap-3">
        {snapshot?.versionAdvisory?.status === 'behind_latest' && <div className="flex items-center justify-between gap-2">
          <div><p className="text-xs text-amber-400">Update available · v{snapshot.versionAdvisory.latestVersion}</p><p className="mt-1 text-xs text-muted">{snapshot.versionAdvisory.updateCommand?.startsWith('brew ') ? 'Homebrew installation. New releases can reach Homebrew later.' : 'Updates the installed provider using its package manager.'}</p></div>
          <button className={btn.primary} disabled={busy || dirty || !snapshot.versionAdvisory.canUpdate} onClick={() => void operate('update', { provider: draft.driver, instanceId: selected })}>Update provider</button>
        </div>}
        {snapshot?.versionAdvisory?.status === 'behind_latest' && !snapshot.versionAdvisory.canUpdate && <p className="text-xs text-muted">{agentProductCopy(snapshot.versionAdvisory.message || 'Automatic updates are unavailable for this installation.')} {snapshot.versionAdvisory.updateCommand}</p>}
        {snapshot?.updateState?.output && <details className="rounded-md border border-subtle p-3"><summary className="cursor-pointer text-xs text-secondary">Update output</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">{agentProductCopy(snapshot.updateState.output)}</pre></details>}
        </div>
        <div role="tablist" aria-label="Provider settings" className="mt-4 flex gap-5 border-b border-subtle px-5">
          {['Configuration', 'Models', 'Environment'].map((name) => <button role="tab" aria-selected={tab === name} key={name} onClick={() => setTab(name)} className={`pb-3 text-xs border-b-2 transition-colors ${tab === name ? 'border-focus-blue text-primary' : 'border-transparent text-muted hover:text-primary'}`}>{name}</button>)}
        </div>
        <div className="p-5 flex flex-col gap-4">
        <div hidden={tab !== 'Configuration'} className={tab === 'Configuration' ? 'grid grid-cols-1 sm:grid-cols-2 gap-4' : ''}>
        <label className="text-xs text-secondary">Display name<input className={inputCls} value={draft.displayName ?? ''} onChange={(e) => edit({ displayName: e.target.value || undefined })} /></label>
        <div className="text-xs text-secondary">Accent color<div className="mt-2 flex gap-2">{['#3b82f6', '#22c55e', '#f97316', '#ef4444', '#a855f7', '#06b6d4'].map((color) => <button key={color} aria-label={`Accent ${color}`} aria-pressed={(draft.accentColor || '#3b82f6') === color} onClick={() => edit({ accentColor: color })} style={{ backgroundColor: color }} className="h-6 w-6 rounded-full flex items-center justify-center text-white hover:ring-2 ring-offset-2 ring-focus-blue">{(draft.accentColor || '#3b82f6') === color && <Check size={13} weight="bold" />}</button>)}<input type="color" aria-label="Custom accent color" className="h-6 w-6 rounded-full overflow-hidden border-0 bg-transparent cursor-pointer" value={draft.accentColor || '#3b82f6'} onChange={(e) => edit({ accentColor: e.target.value })} /></div></div>
        {(fields[draft.driver] ?? []).filter(([key]) => key === 'binaryPath').map(([key, label]) => <label key={key} className="text-xs text-secondary sm:col-span-2">{label}<input className={inputCls} value={draft.config?.[key] ?? ''} onChange={(e) => editConfig(key, e.target.value)} /></label>)}
        {(fields[draft.driver]?.length ?? 0) > 1 && <details className="sm:col-span-2"><summary className="cursor-pointer text-xs text-muted">Advanced configuration</summary><div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4">{fields[draft.driver].filter(([key]) => key !== 'binaryPath').map(([key, label]) => <label key={key} className="text-xs text-secondary">{label}<input className={inputCls} type={key === 'serverPassword' ? 'password' : 'text'} value={draft.config?.[key] ?? ''} onChange={(e) => editConfig(key, e.target.value)} /></label>)}</div></details>}
        </div>
        <div hidden={tab !== 'Models'}>
          <p className="my-2 text-xs text-muted">Available models: {(snapshot?.models ?? []).map((model: any) => model.name || model.id).join(', ') || 'No models reported yet.'}</p>
          <label className="text-xs text-secondary">Custom models (one per line)<textarea className={inputCls} value={(draft.config?.customModels ?? []).join('\n')} onChange={(e) => editConfig('customModels', e.target.value.split('\n'))} /></label>
        </div>
        <div hidden={tab !== 'Environment'}>
          <p className="my-2 text-xs text-muted">Sensitive values are stored by the provider harness and remain hidden after saving.</p>
          {(draft.environment ?? []).map((entry, index) => <div key={index} className="flex flex-wrap items-center gap-2 my-2">
            <input aria-label={`Variable name ${index + 1}`} className={`${inputCls} flex-1`} value={entry.name} onChange={(e) => edit({ environment: draft.environment!.map((item, i) => i === index ? { ...item, name: e.target.value } : item) })} />
            <input aria-label={`Variable value ${index + 1}`} className={`${inputCls} flex-1`} type={entry.sensitive ? 'password' : 'text'} value={entry.value} placeholder={entry.valueRedacted ? 'Stored securely' : 'Value'} onChange={(e) => edit({ environment: draft.environment!.map((item, i) => i === index ? { ...item, value: e.target.value, valueRedacted: false } : item) })} />
            <label className="text-xs"><input type="checkbox" checked={entry.sensitive} onChange={(e) => edit({ environment: draft.environment!.map((item, i) => i === index ? { ...item, sensitive: e.target.checked } : item) })} /> Secret</label>
            <button className={btn.secondary} onClick={() => edit({ environment: draft.environment!.filter((_, i) => i !== index) })}>Remove</button>
          </div>)}
          <button className={btn.secondary} onClick={() => edit({ environment: [...draft.environment ?? [], { name: '', value: '', sensitive: true }] })}>Add variable</button>
        </div>
        </div>
        {dirty && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle bg-surface-3/50 px-5 py-3"><p className="text-xs text-muted">Unsaved changes</p><div className="flex gap-2"><button className={btn.secondary} disabled={busy} onClick={() => setDirty(false)}>Discard changes</button><button className={btn.primary} disabled={busy} onClick={save}>Save provider</button></div></div>}
      </fieldset>
      <details className="rounded-lg border border-subtle p-4"><summary className="cursor-pointer text-xs text-secondary">Additional provider accounts</summary><p className="my-3 text-xs text-muted">Add a separate configuration for another account or endpoint.</p><div className="flex gap-2"><select aria-label="New provider type" className={inputCls} value={newDriver} onChange={(e) => setNewDriver(e.target.value)}>{drivers.map((driver) => <option key={driver} value={driver}>{names[driver]}</option>)}</select><button className={`${btn.secondary} shrink-0`} disabled={busy || dirty} onClick={() => {
        const id = `${newDriver}-${crypto.randomUUID().slice(0, 8)}`
        void operate('save', { patch: { providerInstances: { ...settings.providerInstances, [id]: { driver: newDriver, enabled: true, config: {} } } } })
      }}><Plus size={13} />Add instance</button></div></details>
      {!drivers.includes(selected) && <button className={btn.danger} disabled={busy || dirty} onClick={() => {
        const remaining = { ...settings.providerInstances }
        delete remaining[selected]
        setSelected('codex')
        void operate('save', { patch: { providerInstances: remaining } })
      }}>Remove selected instance</button>}
      <details className="rounded-lg border border-subtle p-4"><summary className="cursor-pointer text-xs text-secondary">Agent preferences</summary><div className="flex flex-col gap-3 py-3">
        {([['enableProviderUpdateChecks', 'Check for provider updates'], ['enableLegacyTokenStreaming', 'Legacy token streaming'], ['sidebarAutoSettleOnMerge', 'Settle chats after merge']] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!settings[key]} disabled={busy || dirty} onChange={(e) => void operate('save', { patch: { [key]: e.target.checked } })} />{label}</label>)}
        <label className="text-xs text-secondary">Provider status refresh interval
          <select className={inputCls} disabled={busy || dirty} value={settings.providerHealthRefreshInterval ?? 30000} onChange={(e) => void operate('save', { patch: { providerHealthRefreshInterval: Number(e.target.value) } })}>
            {[15000, 30000, 60000, 300000].map((ms) => <option key={ms} value={ms}>{ms / 1000} seconds</option>)}
          </select>
        </label>
        <label className="text-xs text-secondary">Automatically settle inactive chats
          <select className={inputCls} disabled={busy || dirty} value={settings.sidebarAutoSettleAfterDays ?? 'never'} onChange={(e) => void operate('save', { patch: { sidebarAutoSettleAfterDays: e.target.value === 'never' ? null : Number(e.target.value) } })}>
            <option value="never">Never</option>{[1, 3, 7, 14, 30].map((days) => <option key={days} value={days}>After {days} days</option>)}
          </select>
        </label>
        <label className="text-xs text-secondary">Model for generated chat titles
          <select className={inputCls} disabled={busy || dirty} value={JSON.stringify([settings.textGenerationModelSelection?.instanceId, settings.textGenerationModelSelection?.model])} onChange={(e) => {
            const [instanceId, model] = JSON.parse(e.target.value)
            void operate('save', { patch: { textGenerationModelSelection: { instanceId, model, options: [] } } })
          }}>
            <option value={JSON.stringify([settings.textGenerationModelSelection?.instanceId, settings.textGenerationModelSelection?.model])}>{settings.textGenerationModelSelection?.model ?? 'Default'}</option>
            {providers.flatMap((provider) => (provider.models ?? []).map((model: any) => <option key={`${provider.instanceId}:${model.slug}`} value={JSON.stringify([provider.instanceId, model.slug])}>{provider.displayName || names[provider.driver]} · {model.name}</option>))}
          </select>
        </label>
      </div></details>
    </>}
  </div>
}
