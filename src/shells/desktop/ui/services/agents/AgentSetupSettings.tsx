import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Download, LogIn, Monitor, RefreshCw } from 'lucide-react'
import { clientUi } from '@kernel/interaction'
import type { AgentId, AgentSetupInfo, AgentSetupOperation } from '@services/agents/contract'
import { useRuntime } from '../../kernel/rpc'
import { LoadingState, SearchableBlock } from '../../kernel/interaction'
import { useAgentAvailability } from './useAgentAvailability'
import { AgentMark } from './AgentMark'
import { AgentProviders } from './AgentProviders'
import { AgentHookControl, useAgentHookSettings } from './AgentHooksSettings'

const actionClass = 'rounded-md border border-subtle px-2.5 py-1.5 text-xs text-secondary hover:bg-hover hover:text-primary disabled:opacity-40 disabled:pointer-events-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-blue'

function authenticationLabel(auth: AgentSetupInfo['authentication']): string {
  if (auth.status === 'signed-out') return 'Not signed in'
  if (auth.status === 'unknown') return 'Account unavailable'
  const identity = auth.email ?? auth.displayName
  return identity ?? `Signed in${auth.method ? ` · ${auth.method}` : ''}`
}

/** CLI setup always acts on the selected workspace's runtime host. Native
 * login runs in its own terminal; only safe identity and progress reach here. */
export function AgentSetupSettings({ workspaceId, onOpenSetupTerminal }: {
  workspaceId: string | null | undefined
  /** The app reveals the native setup terminal and dismisses its settings overlay. */
  onOpenSetupTerminal?(panelId: string): Promise<boolean>
}) {
  const runtime = useRuntime(workspaceId)
  const hooks = useAgentHookSettings(workspaceId)
  const [expanded, setExpanded] = useState<AgentId | null>(null)
  const availability = useAgentAvailability(workspaceId)
  const snapshot = availability?.snapshot ?? null
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Partial<Record<AgentId, string>>>({})
  const operations: Partial<Record<AgentId, AgentSetupOperation>> = {}
  for (const operation of snapshot?.operations ?? []) {
    const previous = operations[operation.agentId]
    if (!previous || previous.startedAt < operation.startedAt) operations[operation.agentId] = operation
  }
  const [pending, setPending] = useState<AgentId[]>([])
  const generation = useRef(0)
  const invalidate = useCallback(() => { generation.current++ }, [])

  const refresh = useCallback(async () => {
    if (!runtime) return
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      await runtime.agents.setupInspect({ refresh: true })
    } catch {
      if (generation.current === request) setError('Could not inspect agents on this runtime. Try refreshing.')
    } finally {
      if (generation.current === request) setLoading(false)
    }
  }, [runtime])

  useEffect(() => {
    setPending([])
    setErrors({})
    setExpanded(null)
    return invalidate
  }, [refresh, invalidate])

  const perform = async (agentId: AgentId, work: () => Promise<unknown>) => {
    const current = generation.current
    setErrors((all) => ({ ...all, [agentId]: undefined }))
    setPending((all) => [...all, agentId])
    try {
      await work()
    } catch (cause) {
      if (generation.current === current) setErrors((all) => ({ ...all, [agentId]: cause instanceof Error ? cause.message : 'Setup failed. Please try again.' }))
    } finally {
      setPending((all) => all.filter((id) => id !== agentId))
    }
  }

  if (!runtime) return <p className="py-2 text-xs text-muted">Open a workspace to set up agents on its runtime.</p>

  const begin = (agentId: AgentId, action: 'login' | 'install') => perform(agentId, async () => {
    await runtime.agents.setupBegin({ agentId, action })
  })

  const configure = (agentId: AgentId, providerId?: string, model?: string) => perform(agentId, async () => {
    await runtime.agents.setupConfigure({ agentId, connection: providerId ? 'api' : 'native', providerId, model })
  })

  return (
    <SearchableBlock keywords="agents hooks activity setup install download login account claude codex cursor grok kiro opencode pi api provider key model approvals permissions">
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted" title={snapshot ? `${snapshot.host.platform} / ${snapshot.host.arch}` : undefined}>
          <Monitor size={14} className="shrink-0" />
          <span className="truncate">{snapshot?.host.name ?? 'Runtime'}</span>
        </span>
        <button type="button" aria-label="Refresh agents" title="Refresh agents" className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-primary disabled:opacity-40" disabled={loading || hooks.loading} onClick={() => { void refresh(); void hooks.refresh() }}>
          <RefreshCw size={14} className={loading || hooks.loading ? 'animate-spin' : ''} />
        </button>
      </div>
      {(loading || availability?.refreshing) && !snapshot && <LoadingState label="Loading agents" size={14} className="justify-start py-3 text-xs" />}
      {(error || availability?.error) && <p role="alert" className="py-2 text-xs text-muted">{error || availability?.error}</p>}
      {hooks.error && <p role="alert" className="py-2 text-xs text-muted">{hooks.error}</p>}
      {workspaceId && snapshot && <AgentProviders key={workspaceId} workspaceId={workspaceId} providers={snapshot.providers} />}
      {snapshot?.agents.map((inspected) => {
        const agent = inspected
        const operation = operations[agent.agentId]
        const working = pending.includes(agent.agentId) || operation?.status === 'running'
        const installed = agent.installation.status === 'installed'
        const apiActive = agent.connection === 'api'
        const open = expanded === agent.agentId
        const ready = availability?.types.find((type) => type.agentId === agent.agentId)?.ready ?? false
        const status = !installed ? agent.installation.status === 'missing' ? 'Not installed' : 'Unavailable'
          : agent.hooksReady === false ? 'Integration off' : ready ? 'Ready' : agent.authentication.status === 'signed-out' ? 'Sign in' : 'Installed'
        const identity = installed ? authenticationLabel(agent.authentication) : null
        const selectedProvider = snapshot.providers.find((p) => p.id === agent.providerId)
        const compatible = snapshot.providers.filter((p) => p.api === agent.api.protocol)
        return (
          <div key={agent.agentId} data-agent-setup-id={agent.agentId} className="-mx-3 border-b border-subtle px-3 last:border-b-0">
            <h3>
              <button type="button" id={`agent-heading-${agent.agentId}`} aria-label={`${agent.displayName} settings`} aria-expanded={open} aria-controls={`agent-options-${agent.agentId}`} className="flex min-h-14 w-full items-center gap-3 rounded-md py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-blue" onClick={() => setExpanded(open ? null : agent.agentId)}>
                <AgentMark agent={agent.agentId} size={22} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-primary">{agent.displayName}</span>
                    <span className="inline-flex items-center gap-1 text-[10px] text-muted" title={agent.installation.detail}>
                      <span className={`h-1.5 w-1.5 rounded-full ${ready ? 'bg-[var(--git-added)]' : 'bg-current opacity-40'}`} />{status}
                    </span>
                  </span>
                  {identity && <span className="mt-0.5 block truncate text-[11px] font-normal text-muted" title={[identity, agent.authentication.detail].filter(Boolean).join(' · ')}>{identity}{agent.authentication.plan ? ` · ${agent.authentication.plan}` : ''}</span>}
                </span>
                {apiActive && <span className="shrink-0 text-[10px] font-normal text-muted">{selectedProvider?.name ?? 'API provider'}</span>}
                <ChevronDown size={15} className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
            </h3>
            {open && <div id={`agent-options-${agent.agentId}`} role="region" aria-labelledby={`agent-heading-${agent.agentId}`} className="ml-[34px] space-y-1 pb-3 text-xs">
              {installed && agent.canLogin && <div className="flex min-h-10 items-center justify-between gap-3 py-2">
                <span className="text-[13px] font-medium text-primary">Account</span>
                <button type="button" className={actionClass} disabled={working} onClick={() => { void begin(agent.agentId, 'login') }}><span className="inline-flex items-center gap-1.5"><LogIn size={12} />{agent.authentication.status === 'signed-in' ? 'Switch account' : 'Sign in'}</span></button>
              </div>}
              {installed && agent.api.protocol && <div className="space-y-2 py-2">
                <label className="flex items-center justify-between gap-3 text-[13px] font-medium text-primary">Connection
                  <select aria-label={`${agent.displayName} connection`} className="max-w-[65%] rounded-md border border-subtle bg-surface-2 px-2 py-1.5 text-xs text-secondary" value={apiActive ? agent.providerId ?? '' : 'native'} disabled={working} onChange={(e) => {
                    const provider = compatible.find((p) => p.id === e.target.value)
                    void configure(agent.agentId, provider?.id, provider?.models[0]?.id)
                  }}>
                    <option value="native">Native account</option>
                    {apiActive && !compatible.some((p) => p.id === agent.providerId) && <option value={agent.providerId ?? ''}>Provider unavailable</option>}
                    {compatible.map((p) => <option key={p.id} value={p.id} disabled={!p.hasKey}>{p.name}</option>)}
                  </select>
                </label>
                {!compatible.length && <p className="text-[11px] text-muted">Add a {agent.api.protocol} provider above to use an API key.</p>}
                {apiActive && selectedProvider && <label className="flex items-center justify-between gap-3 text-[13px] font-medium text-primary">Model
                  <select aria-label={`${agent.displayName} model`} className="max-w-[65%] rounded-md border border-subtle bg-surface-2 px-2 py-1.5 text-xs text-secondary" value={agent.model ?? ''} disabled={working} onChange={(e) => { void configure(agent.agentId, selectedProvider.id, e.target.value) }}>
                    {!selectedProvider.models.some((m) => m.id === agent.model) && <option value={agent.model ?? ''}>Select a model</option>}
                    {selectedProvider.models.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
                  </select>
                </label>}
                {apiActive && !agent.api.configured && <p role="alert" className="text-[11px] text-muted">Update this provider's API key, protocol or model selection before launching.</p>}
              </div>}
              {installed && !agent.api.protocol && <p className="py-2 text-[11px] text-muted">{agent.api.reason}</p>}
              {installed && <div className="py-2"><AgentHookControl agentId={agent.agentId} name={agent.displayName} controller={hooks} /></div>}
              {!installed && agent.canInstall && <div className="flex min-h-10 items-center justify-between gap-3 py-2"><span className="text-[13px] font-medium text-primary">Installation</span><button type="button" className={actionClass} disabled={working} onClick={() => { void begin(agent.agentId, 'install') }}>Install</button></div>}
              <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-[11px] text-muted">{installed ? `Version ${agent.installation.version ?? 'unknown'}` : agent.installation.detail ?? 'Not installed'}</span>
                <button type="button" aria-label={`${agent.displayName} download`} title="Official download" className="inline-flex items-center gap-1.5 text-xs text-secondary hover:text-primary" onClick={() => clientUi().openExternal(agent.downloadUrl)}><Download size={12} />Download</button>
              </div>
            </div>}
            {operation && (operation.status === 'running' || operation.status === 'failed') && <div role="status" className="mt-2 flex flex-wrap items-center gap-2 pl-[34px] text-xs text-secondary">
              <span>{operation.status === 'running' ? operation.action === 'login' ? 'Signing in…' : 'Installing…' : operation.message ?? 'Setup failed.'}</span>
              {operation.panelId && onOpenSetupTerminal && <button type="button" className={actionClass} disabled={pending.includes(agent.agentId)} onClick={() => { void perform(agent.agentId, async () => { if (!await onOpenSetupTerminal(operation.panelId!)) throw new Error('The setup terminal is no longer open. Start setup again to open a new terminal.') }) }}>Open setup terminal</button>}
              {operation.status === 'running' && <button type="button" className={actionClass} disabled={pending.includes(agent.agentId)} onClick={() => { void perform(agent.agentId, async () => { await runtime.agents.setupCancel({ operationId: operation.id }) }) }}>Cancel</button>}
            </div>}
            {errors[agent.agentId] && <p role="alert" className="mt-2 pl-[34px] text-xs text-muted">{errors[agent.agentId]}</p>}
          </div>
        )
      })}
    </SearchableBlock>
  )
}
