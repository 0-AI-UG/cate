import { useEffect, useMemo, useState } from 'react'
import { useStatusStore } from '../stores/statusStore'
import { useSettingsStore } from '../stores/settingsStore'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { matchAgentDef } from '../../shared/agents'
import type { AgentHookAgentState } from '../../shared/agentHooks'

// Detector for "a supported agent CLI is running in this terminal, but Cate's
// hooks aren't installed for it here." Agent state/name now come exclusively
// from hooks; when a repo has no injected hook file the agent runs invisibly to
// Cate. This nudges the user to Settings → Agent Hooks. It reuses three facts
// the rest of the app already owns — the process-scan child name (matched
// against the agent registry), the hook-anchored presence flag, and the
// per-workspace injection readout (agentHooksInspect) — so it auto-clears the
// moment the agent exits, starts posting hooks, or a hook file gets injected.
//
// The presence flag is what keeps this HONEST. `agentHooksInspect(rootPath)`
// only answers "is a hook file present in THIS workspace root" — it says
// nothing about whether hooks actually fire. Hooks configured elsewhere
// (~/.claude, an agent cwd ≠ rootPath) fire fine yet leave rootPath's file
// absent, which would false-positive the nudge. `agentPresent` is set by a real
// hook post (agentPresence.ts), so gating on !agentPresent means "no hook has
// spoken for this terminal" — the actual condition worth nudging about.
//
// Blind spot (inherited from the process scan, see process.ts / #480): under
// tmux/screen/setsid the agent is detached from the pty's subtree, so the scan
// yields no processName and the nudge simply doesn't show. That fails safe (no
// false nudge) and matches the accepted "hooks that never fire aren't detected"
// gap — the fix there is the same as everywhere: install the hooks.
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

  // Hook-anchored presence: true once a real hook post has been attributed to
  // this terminal (agentPresence.ts). If hooks are speaking, they own the name
  // and state — there is nothing to nudge about, regardless of whether a hook
  // file happens to live in rootPath.
  const agentPresent = useStatusStore((s) =>
    ptyId ? (s.workspaces[workspaceId]?.terminals[ptyId]?.agentPresent ?? false) : false,
  )

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
  // Hooks are already firing for this terminal — nothing to nudge.
  if (agentPresent) return null
  // Only show once the inspect confirms the hook file is absent — an unknown
  // (not-yet-inspected) agent must not flash the chip.
  if (injectedById[agent.id] !== false) return null
  return agent.displayName
}
