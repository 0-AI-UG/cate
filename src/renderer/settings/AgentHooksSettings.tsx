// =============================================================================
// Agent hooks settings — per-workspace, per-agent control over Cate's hook
// injection (the push-based agent status/session events). Every agent injects
// through workspace files, so every agent gets the same tri-state: Auto (inject
// only when the agent's own config folder is already in the repo), On, or Off.
//
// Overrides live in settings.agentHookInjection keyed by workspace id and are
// applied by the terminal layer on the NEXT terminal spawn (injection is a
// per-spawn, idempotent operation — see src/runtime/capabilities/agentHooks.ts).
// The live state readout is inspected from the workspace's files on open.
// =============================================================================

import { getAgentLogoById } from '../lib/agent/agentLogos'
import { useEffect, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useSelectedWorkspace } from '../stores/appStore'
import { SearchableBlock } from './SettingsComponents'
import type { AgentId } from '../../shared/agents'
import type { AgentHookMode } from '../../shared/agentHooks'
import { LoadingState } from '../ui/Spinner'
import {
  evaluateAgentCliHooks,
  inspectAgentCliHooks,
  type AgentCliHookState,
} from '../lib/agent/agentCliHooks'

const MODE_OPTIONS = [
  { value: 'auto', label: 'Auto', description: 'Enable when the agent is configured in this workspace' },
  { value: 'on', label: 'On', description: 'Install hooks for new terminals' },
  { value: 'off', label: 'Off', description: 'Disable hooks for new terminals' },
] as const

export function AgentHooksSettings() {
  const store = useSettingsStore()
  const workspace = useSelectedWorkspace()
  const [error, setError] = useState(false)
  const [agents, setAgents] = useState<AgentCliHookState[] | null>(null)

  const locator = workspace?.rootPath
  useEffect(() => {
    if (!locator) {
      setAgents(null)
      return
    }
    let live = true
    setAgents(null)
    setError(false)
    void inspectAgentCliHooks(locator)
      .then((r) => {
        if (live) setAgents(r)
      })
      .catch(() => {
        if (live) { setAgents([]); setError(true) }
      })
    return () => {
      live = false
    }
  }, [locator])

  if (!workspace) {
    return <p className="text-xs text-muted py-2">Open a workspace to configure its agent hooks.</p>
  }

  const overrides = store.agentHookInjection[workspace.id] ?? {}

  const setMode = (agentId: AgentId, mode: AgentHookMode) => {
    const all = { ...store.agentHookInjection }
    const ws = { ...(all[workspace.id] ?? {}) }
    if (mode === 'auto') delete ws[agentId] // sparse: default needs no entry
    else ws[agentId] = mode
    if (Object.keys(ws).length === 0) delete all[workspace.id]
    else all[workspace.id] = ws
    store.setSetting('agentHookInjection', all)
  }

  return (
    <SearchableBlock keywords="agent hooks injection claude codex cursor grok kiro opencode status presence auto on off">
      {agents === null && <LoadingState label="Loading agent hooks…" size={14} className="justify-start py-3 text-xs" />}
      {error && <p role="alert" className="py-3 text-xs text-muted">Could not check agent hooks. Reopen settings to try again.</p>}
      {!!agents?.length && <div>
        {agents.map((a) => {
          const evaluation = evaluateAgentCliHooks(a, overrides)
          const mode: AgentHookMode = evaluation.mode
          const logo = getAgentLogoById(a.agent.id)
          const status = mode === 'off' ? 'Off for new terminals'
            : evaluation.autoSkipped ? 'Not configured in this workspace'
            : a.injected ? 'Hooks installed' : 'Will install when a terminal opens'
          return (
            <div
              key={a.agent.id}
              data-agent-hook-id={a.agent.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-subtle py-3 last:border-b-0"
            >
              <div className="flex min-w-[180px] flex-1 items-center gap-3">
                {logo && <img src={logo} alt="" draggable={false} className="h-5 w-5 shrink-0 object-contain" />}
                <div className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-primary">{a.agent.displayName}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                    {mode !== 'off' && a.injected && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: 'var(--git-added)' }} />}
                    {status}
                  </span>
                </div>
              </div>
              <Segmented
                label={`${a.agent.displayName} hooks`}
                value={mode}
                options={MODE_OPTIONS}
                onChange={(v) => setMode(a.agent.id, v as AgentHookMode)}
              />
            </div>
          )
        })}
      </div>}
    </SearchableBlock>
  )
}

// -----------------------------------------------------------------------------
// Segmented control - compact inline pill group; the selected value is filled.
// -----------------------------------------------------------------------------

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
