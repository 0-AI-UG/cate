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

import { useEffect, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useSelectedWorkspace } from '../stores/appStore'
import { SearchableBlock } from './SettingsComponents'
import type { AgentId } from '../../shared/agents'
import type { AgentHookAgentState, AgentHookMode } from '../../shared/agentHooks'

const MODE_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
] as const

export function AgentHooksSettings() {
  const store = useSettingsStore()
  const workspace = useSelectedWorkspace()
  const [agents, setAgents] = useState<AgentHookAgentState[] | null>(null)

  const locator = workspace?.rootPath
  useEffect(() => {
    if (!locator) {
      setAgents(null)
      return
    }
    let live = true
    setAgents(null)
    void window.electronAPI.agentHooksInspect(locator).then((r) => {
      if (live) setAgents(r)
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
    <div className="flex flex-col gap-1">
      <SearchableBlock keywords="agent hooks injection claude codex cursor grok pi opencode status presence auto on off">
        <p className="text-xs text-muted py-2 leading-relaxed">
          Cate writes tiny git-ignored hook files so agent CLIs report session and turn status
          back to it. <span className="text-secondary">Auto</span> injects only where an agent&apos;s
          config folder already exists. Changes apply to terminals opened after saving.
        </p>
      </SearchableBlock>

      {agents === null && <p className="text-xs text-muted py-3">Loading…</p>}

      <div className="flex flex-col">
        {(agents ?? []).map((a) => {
          const mode: AgentHookMode = overrides[a.agentId] ?? 'auto'
          // The one "looks on but does nothing" state we can detect: Auto with
          // no config folder present, so Auto silently skips injection here.
          const dormant = mode === 'auto' && !a.folderPresent
          return (
            <div key={a.agentId} className="flex items-center gap-3 py-2.5 border-b border-subtle">
              <div className="flex flex-col flex-1 min-w-0">
                <span className="text-sm text-primary truncate">{a.displayName}</span>
                {dormant && (
                  <span className="text-xs text-muted mt-0.5">Auto skips here: no config folder yet.</span>
                )}
              </div>
              <Segmented
                value={mode}
                options={MODE_OPTIONS}
                onChange={(v) => setMode(a.agentId, v as AgentHookMode)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Segmented control - compact inline pill group; the selected value is filled.
// -----------------------------------------------------------------------------

interface SegmentedProps {
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange: (value: string) => void
}

function Segmented({ value, options, onChange }: SegmentedProps) {
  return (
    <div className="inline-flex flex-shrink-0 rounded-md bg-surface-5 border border-subtle p-0.5">
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`px-2.5 py-1 text-xs rounded transition-colors ${
              active ? 'bg-focus-blue text-white' : 'text-secondary hover:text-primary'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
