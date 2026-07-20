// =============================================================================
// Agent hooks settings — per-workspace, per-agent control over Cate's repo-local
// hook-file injection (the push-based agent status/session events). Each coding
// agent CLI gets a tri-state: Auto (inject only when the agent's own config
// folder is already in the repo), Always on, or Off. Env-only agents (opencode)
// are always on and write no repo files, so they have no control here.
//
// Overrides live in settings.agentHookInjection keyed by workspace id and are
// applied by the terminal layer on the NEXT terminal spawn (injection is a
// per-spawn, idempotent operation — see src/runtime/capabilities/agentHooks.ts).
// The live state readout is inspected from the workspace's files on open.
// =============================================================================

import { useEffect, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useSelectedWorkspace } from '../stores/appStore'
import { SettingRow, Select, SearchableBlock } from './SettingsComponents'
import type { AgentId } from '../../shared/agents'
import type { AgentHookAgentState, AgentHookMode } from '../../shared/agentHooks'

const MODE_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'Always on' },
  { value: 'off', label: 'Off' },
]

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
      <SearchableBlock keywords="agent hooks injection claude codex cursor pi opencode status presence">
        <p className="text-xs text-muted py-2 leading-relaxed">
          Cate writes small, git-ignored hook files into a repo so agent CLIs report their
          session and turn status back to Cate. <span className="text-secondary">Auto</span> injects
          only when an agent&apos;s own config folder (e.g. <code className="text-secondary">.claude</code>)
          already exists here. Changes apply to terminals you open after saving.
        </p>
      </SearchableBlock>

      {(agents ?? []).map((a) => {
        if (!a.fileInjecting) {
          return (
            <SettingRow key={a.agentId} label={a.displayName} description="Always on — injected via env, writes no repo files">
              <span className="text-xs text-muted">Always on</span>
            </SettingRow>
          )
        }
        const mode: AgentHookMode = overrides[a.agentId] ?? 'auto'
        return (
          <SettingRow key={a.agentId} label={a.displayName} description={stateText(a, mode)}>
            <Select value={mode} options={MODE_OPTIONS} onChange={(v) => setMode(a.agentId, v as AgentHookMode)} />
          </SettingRow>
        )
      })}

      {agents === null && <p className="text-xs text-muted py-2">Loading…</p>}
    </div>
  )
}

/** The per-agent state line: current on-disk facts, plus what 'auto' would do
 *  here. Kept terse — the row's control carries the choice. */
function stateText(a: { folderPresent: boolean; injected: boolean }, mode: AgentHookMode): string {
  const folder = a.folderPresent ? 'config folder present' : 'no config folder'
  const injected = a.injected ? 'injected' : 'not injected'
  const autoNote = mode === 'auto' ? (a.folderPresent ? ' — auto injects' : ' — auto skips') : ''
  return `${folder} · ${injected}${autoNote}`
}
