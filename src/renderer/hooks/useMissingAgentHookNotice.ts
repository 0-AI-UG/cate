import { useEffect, useMemo, useState } from 'react'
import { useStatusStore } from '../stores/statusStore'
import { useSettingsStore } from '../stores/settingsStore'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { matchAgentDef } from '../../shared/agents'
import type { AgentHookAgentState } from '../../shared/agentHooks'

// Detector for "a supported agent CLI is running in this terminal, but Cate's
// hooks aren't installed for it here." Agent state/name now come exclusively
// from hooks; when a repo has no injected hook file the agent runs invisibly to
// Cate. This nudges the user to Settings → Agent Hooks. It reuses the same two
// facts the rest of the app already owns — the process-scan child name
// (matched against the agent registry) and the per-workspace injection readout
// (agentHooksInspect) — so it auto-clears the moment the agent exits or a hook
// file gets injected.
//
// Returns the agent's display name while the notice should show, else null.
export function useMissingAgentHookNotice(
  workspaceId: string,
  panelId: string,
  rootPath: string | undefined,
): string | null {
  const ptyId = terminalRegistry.ptyIdForPanel(panelId)

  // The child process name the activity scan sees in this terminal. Null unless
  // something non-shell is running (an agent CLI sitting at its prompt still
  // counts — its process is alive).
  const processName = useStatusStore((s) => {
    if (!ptyId) return null
    const activity = s.workspaces[workspaceId]?.terminals[ptyId]?.activity
    return activity?.type === 'running' ? activity.processName : null
  })
  const agent = useMemo(() => (processName ? matchAgentDef(processName) : null), [processName])

  // Re-inspect the workspace's live hook files when the running agent changes or
  // the user edits this workspace's injection overrides in Settings (a respawn
  // then rewrites the files).
  const overrides = useSettingsStore((s) => s.agentHookInjection[workspaceId])
  const [injectedById, setInjectedById] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!agent || !rootPath) return
    let live = true
    void window.electronAPI.agentHooksInspect(rootPath).then((states: AgentHookAgentState[]) => {
      if (live) setInjectedById(Object.fromEntries(states.map((a) => [a.agentId, a.injected])))
    })
    return () => {
      live = false
    }
  }, [agent, rootPath, overrides])

  if (!agent) return null
  // Only show once the inspect confirms the hook file is absent — an unknown
  // (not-yet-inspected) agent must not flash the chip.
  if (injectedById[agent.id] !== false) return null
  return agent.displayName
}
