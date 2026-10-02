// Agent hooks settings: per-agent control over Cate's repo-local hook
// injection in this workspace (the `agentHookInjection` workspace setting).
// Auto enables an agent's hooks when its own config folder is in the repo;
// On and Off force it. The runtime applies a change on the next terminal
// spawn. The readout is inspected from the workspace's files on open (and on
// Refresh detection). For a CLI whose approvals are told apart by config
// (Codex) it also shows a read-only Approvals label; Cate never changes the
// CLI's permission policy (docs/agent-activity.md).

import { useEffect, useRef, useState } from 'react'
import { useRuntime } from '@kernel/rpc/ui'
import { createWorkspaceSettingsMirror, type WorkspaceSettingsMirror } from '@kernel/settings/client'
import { LoadingState, SearchableBlock } from '@kernel/ui'
import {
  AGENTS,
  AGENT_APPROVAL_DETECTION,
  agentHookInUse,
  agentHooksEnabled,
  resolveAgentHookMode,
  type AgentApprovalDetection,
  type AgentDef,
  type AgentHookAgentState,
  type AgentHookConfig,
  type AgentHookMode,
  type AgentId,
} from '../contract'
import { agentLogo } from './logos'

const MODE_OPTIONS = [
  { value: 'auto', label: 'Auto', description: 'Enable when the agent is configured in this workspace' },
  { value: 'on', label: 'On', description: 'Install hooks for new terminals' },
  { value: 'off', label: 'Off', description: 'Disable hooks for new terminals' },
] as const

interface AgentHookRow {
  agent: AgentDef
  folderPresent: boolean
  injected: boolean
  approvalDetection: AgentApprovalDetection
}

const APPROVAL_LABELS = { automatic: 'Automatic', manual: 'Manual', unknown: 'Unknown' } as const

/** Inspection results in registry order, one row per agent. */
function agentHookRows(live: readonly AgentHookAgentState[]): AgentHookRow[] {
  const byId = new Map(live.map((state) => [state.agentId, state]))
  return AGENTS.map((agent) => ({
    agent,
    folderPresent: byId.get(agent.id)?.folderPresent ?? false,
    injected: byId.get(agent.id)?.injected ?? false,
    approvalDetection: byId.get(agent.id)?.approvalDetection ?? AGENT_APPROVAL_DETECTION[agent.id],
  }))
}

function agentHookStatus(row: AgentHookRow, config: AgentHookConfig): { mode: AgentHookMode; label: string } {
  const mode = resolveAgentHookMode(config, row.agent.id)
  const inUse = agentHookInUse(row.agent.id, { folderPresent: row.folderPresent })
  if (mode === 'off') return { mode, label: 'Off for new terminals' }
  if (!agentHooksEnabled(mode, inUse)) return { mode, label: 'Not configured in this workspace' }
  return { mode, label: row.injected ? 'Hooks installed' : 'Will install when a terminal opens' }
}

/** Sparse: Auto needs no entry. */
function withHookMode(config: AgentHookConfig, agentId: AgentId, mode: AgentHookMode): AgentHookConfig {
  const next = { ...config }
  if (mode === 'auto') delete next[agentId]
  else next[agentId] = mode
  return next
}

export function AgentHooksSettings({ workspaceId }: { workspaceId: string | null | undefined }) {
  const runtime = useRuntime(workspaceId)
  const [rows, setRows] = useState<AgentHookRow[] | null>(null)
  const [error, setError] = useState(false)
  const [config, setConfig] = useState<AgentHookConfig>({})
  const [refresh, setRefresh] = useState(0)
  const mirror = useRef<WorkspaceSettingsMirror | null>(null)

  useEffect(() => {
    setRows(null)
    setError(false)
    if (!runtime) return
    let live = true
    runtime.agents.inspectHooks({}).then(
      (states) => { if (live) setRows(agentHookRows(states)) },
      () => { if (live) { setRows([]); setError(true) } },
    )
    return () => { live = false }
  }, [runtime, refresh])

  useEffect(() => {
    if (!runtime) return
    const settings = createWorkspaceSettingsMirror(runtime.settings)
    mirror.current = settings
    setConfig(settings.get('agentHookInjection'))
    const off = settings.subscribe((values) => setConfig(values.agentHookInjection))
    return () => {
      off()
      settings.dispose()
      if (mirror.current === settings) mirror.current = null
    }
  }, [runtime])

  if (!runtime) {
    return <p className="text-xs text-muted py-2">Open a workspace to configure its agent hooks.</p>
  }

  const setMode = (agentId: AgentId, mode: AgentHookMode) => {
    void mirror.current?.set('agentHookInjection', withHookMode(config, agentId, mode)).catch(() => {})
  }

  return (
    <SearchableBlock keywords="agent hooks injection claude codex cursor grok hermes kiro opencode status presence auto on off approval automatic manual permissions">
      <button type="button" className="text-xs text-muted hover:text-primary" onClick={() => setRefresh((value) => value + 1)}>Refresh detection</button>
      {rows === null && <LoadingState label="Loading agent hooks" size={14} className="justify-start py-3 text-xs" />}
      {error && <p role="alert" className="py-3 text-xs text-muted">Could not check agent hooks. Refresh detection to try again.</p>}
      {!!rows?.length && !error && <div>
        {rows.map((row) => {
          const { mode, label } = agentHookStatus(row, config)
          const logo = agentLogo(row.agent.id)
          return (
            <div
              key={row.agent.id}
              data-agent-hook-id={row.agent.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-subtle py-3 last:border-b-0"
            >
              <div className="flex min-w-[180px] flex-1 items-center gap-3">
                {logo && <img src={logo} alt="" draggable={false} className="h-5 w-5 shrink-0 object-contain" />}
                <div className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-primary">{row.agent.displayName}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                    {mode !== 'off' && row.injected && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: 'var(--git-added)' }} />}
                    {label}
                  </span>
                </div>
              </div>
              <Segmented
                label={`${row.agent.displayName} hooks`}
                value={mode}
                options={MODE_OPTIONS}
                onChange={(value) => setMode(row.agent.id, value as AgentHookMode)}
              />
              {row.approvalDetection.source === 'config' && (
                <span className="w-full pl-8 text-[11px] text-muted" title={row.approvalDetection.detail}>
                  Approvals: {APPROVAL_LABELS[row.approvalDetection.mode]}
                </span>
              )}
            </div>
          )
        })}
      </div>}
    </SearchableBlock>
  )
}

interface SegmentedProps {
  label: string
  value: string
  options: ReadonlyArray<{ value: string; label: string; description: string }>
  onChange: (value: string) => void
}

function Segmented({ label, value, options, onChange }: SegmentedProps) {
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 rounded-lg border border-subtle bg-surface-1 p-0.5">
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            title={opt.description}
            onClick={() => onChange(opt.value)}
            className={`min-w-10 rounded-md px-2.5 py-1 text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-blue ${
              active ? 'bg-surface-4 font-medium text-primary shadow-sm' : 'text-muted hover:bg-hover hover:text-primary'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
