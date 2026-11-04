// Workspace activity integration shared by the unified Agents settings.
// Native approval policy is inspected, never changed here.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRuntime } from '../../kernel/rpc'
import { useWorkspaceSetting, workspaceSettingsFor, setWorkspaceSetting } from '../../kernel/settings'
import {
  AGENTS, AGENT_DEFS, AGENT_APPROVAL_DETECTION, agentHookInUse, agentHooksEnabled, resolveAgentHookMode,
  type AgentApprovalDetection, type AgentDef, type AgentHookAgentState, type AgentHookConfig, type AgentHookMode, type AgentId,
} from '@services/agents/contract'

const MODE_OPTIONS = [
  { value: 'auto', label: 'Auto', description: 'Enable when the agent is configured in this workspace' },
  { value: 'on', label: 'On', description: 'Install hooks for new terminals' },
  { value: 'off', label: 'Off', description: 'Disable hooks for new terminals' },
] as const
const APPROVAL_LABELS = { automatic: 'Automatic', manual: 'Manual', unknown: 'Unknown' } as const

export interface AgentHookRow {
  agent: AgentDef
  folderPresent: boolean
  injected: boolean
  approvalDetection: AgentApprovalDetection
}
export interface AgentHookController {
  available: boolean
  config: AgentHookConfig
  rows: AgentHookRow[]
  states: Partial<Record<AgentId, AgentHookRow>>
  loading: boolean
  error: string | null
  refresh(): Promise<void>
  setMode(agentId: AgentId, mode: AgentHookMode): Promise<void>
}
function agentHookRows(live: readonly AgentHookAgentState[]): AgentHookRow[] {
  const byId = new Map(live.map((state) => [state.agentId, state]))
  return AGENTS.map((agent) => ({ agent, folderPresent: byId.get(agent.id)?.folderPresent ?? false, injected: byId.get(agent.id)?.injected ?? false, approvalDetection: byId.get(agent.id)?.approvalDetection ?? AGENT_APPROVAL_DETECTION[agent.id] }))
}
function agentHookStatus(row: AgentHookRow, config: AgentHookConfig): string {
  const mode = resolveAgentHookMode(config, row.agent.id)
  const inUse = agentHookInUse(row.agent.id, { folderPresent: row.folderPresent })
  if (mode === 'off') return 'Off for new terminals'
  if (!agentHooksEnabled(mode, inUse)) return 'Not configured in this workspace'
  return row.injected ? 'Hooks installed' : 'Will install when a terminal opens'
}
function withHookMode(config: AgentHookConfig, agentId: AgentId, mode: AgentHookMode): AgentHookConfig {
  const next = { ...config }
  if (mode === 'auto') delete next[agentId]
  else next[agentId] = mode
  return next
}

/** One settings subscription and one inspection for all of the agent rows. */
export function useAgentHookSettings(workspaceId: string | null | undefined): AgentHookController {
  const runtime = useRuntime(workspaceId)
  const [rows, setRows] = useState(() => agentHookRows([]))
  const config = useWorkspaceSetting(workspaceId, 'agentHookInjection')
  const [inspecting, setInspecting] = useState(false)
  const [settingsReady, setSettingsReady] = useState(false)
  const [inspectionError, setInspectionError] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)
  const generation = useRef(0)
  const active = useRef(true)

  useEffect(() => {
    active.current = true
    setSettingsReady(false); setWriteError(null)
    const settings = workspaceId ? workspaceSettingsFor(workspaceId) : null
    let live = true
    void settings?.ready.then(() => { if (live) setSettingsReady(true) })
    return () => { live = false; active.current = false }
  }, [runtime, workspaceId])

  const refresh = useCallback(async () => {
    const request = ++generation.current
    setInspectionError(null)
    if (!runtime) { setRows(agentHookRows([])); setInspecting(false); return }
    setInspecting(true)
    try {
      const states = await runtime.agents.inspectHooks({})
      if (active.current && generation.current === request) setRows(agentHookRows(states))
    } catch {
      if (active.current && generation.current === request) setInspectionError('Could not check agent activity. Refresh agents to try again.')
    } finally {
      if (active.current && generation.current === request) setInspecting(false)
    }
  }, [runtime])
  const invalidateInspection = useCallback(() => { generation.current++ }, [])
  useEffect(() => { void refresh(); return invalidateInspection }, [refresh, invalidateInspection])

  const setMode = useCallback(async (agentId: AgentId, mode: AgentHookMode) => {
    if (!workspaceId) return
    const settings = workspaceSettingsFor(workspaceId)
    if (!settings) return
    setWriteError(null)
    try {
      await setWorkspaceSetting(workspaceId, 'agentHookInjection', withHookMode(settings.get('agentHookInjection'), agentId, mode))
    } catch {
      if (active.current) setWriteError('Could not update agent activity. Try again.')
    }
  }, [workspaceId])
  const states = useMemo(() => Object.fromEntries(rows.map((row) => [row.agent.id, row])), [rows])
  return { available: !!runtime, config, rows, states, loading: !!runtime && (inspecting || !settingsReady), error: inspectionError ?? writeError, refresh, setMode }
}

/** A compact control in an existing agent row; identity belongs to its parent. */
export function AgentHookControl({ agentId, name, controller, onChanged }: { agentId: AgentId; name: string; controller: AgentHookController; onChanged?(): void }) {
  const row = controller.states[agentId] ?? { agent: AGENT_DEFS[agentId], folderPresent: false, injected: false, approvalDetection: AGENT_APPROVAL_DETECTION[agentId] }
  const mode = resolveAgentHookMode(controller.config, agentId)
  const status = controller.loading ? 'Checking agent activity' : agentHookStatus(row, controller.config)
  const installed = mode !== 'off' && row.injected && !controller.loading
  return (
    <div data-agent-hook-id={agentId} className="space-y-3 text-xs text-muted">
      <label className="flex items-center justify-between gap-3">
        <span className="mr-auto text-[13px] font-medium text-primary">Cate integration</span>
        <span aria-label={`${name} integration status`} title={status} className="inline-flex">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: installed ? 'var(--git-added)' : 'currentColor' }} />
          <span className="sr-only">{status}</span>
        </span>
        <select aria-label={`${name} integration`} title="Cate hooks for new terminals" value={mode} disabled={!controller.available || controller.loading} onChange={(event) => { void controller.setMode(agentId, event.target.value as AgentHookMode).then(onChanged) }} className="rounded border border-subtle bg-surface-2 px-1.5 py-0.5 text-[11px] text-secondary disabled:opacity-40">
          {MODE_OPTIONS.map((option) => <option key={option.value} value={option.value} title={option.description}>{option.label}</option>)}
        </select>
      </label>
      {row.approvalDetection.source === 'config' && !controller.loading && <span className="flex justify-between text-[11px]" title={row.approvalDetection.detail}><span>Approvals: </span><span>{APPROVAL_LABELS[row.approvalDetection.mode]}</span></span>}
    </div>
  )
}
