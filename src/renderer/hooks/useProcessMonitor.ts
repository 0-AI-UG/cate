import { useEffect } from 'react'
import { useStatusStore, workspaceIdForTerminal } from '../stores/statusStore'
import { useAppStore } from '../stores/appStore'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { noteAgentPresence } from '../lib/agent/agentScreenDetector'
import { isWorkspaceMonitorReady } from './workspaceMonitorReady'
import { syncWorktrees } from '../lib/worktreeSync'
import log from '../lib/logger'
import type { TerminalActivity } from '../../shared/types'

/** Retained for the statusStore.unregisterTerminal wiring. The per-terminal
 *  rising-edge agent name is now read from statusStore (its single home) rather
 *  than a module-level map, so there is nothing left to forget here. */
export function forgetTerminalForProcessMonitor(_terminalId: string): void {
  // no-op
}

/**
 * Owner-routed terminal telemetry: agent activity/presence/name, listening
 * ports, and cwd. Main sends each of these only to the terminal's OWNER window
 * (sendToWindow(ownerWindowId, …) in main/ipc/shell.ts), so this must run in
 * EVERY window — not just main — or a detached panel/dock window never learns
 * its own terminals' agent presence. Crucially, the agent-screen detector gates
 * `running` on presence (resolveAgentState returns notRunning when !present), so
 * without this a detached terminal's agent never shows the running shimmer even
 * though its spinner is detected locally. Wired once per window from
 * useWindowRuntime; only terminals this window owns are ever delivered here, so
 * there is no cross-window contamination.
 */
export function useOwnedTerminalTelemetry(): void {
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onShellActivityUpdate) return

    const store = useStatusStore.getState

    const unsubscribe = api.onShellActivityUpdate(
      (
        terminalId: string,
        activityRaw: unknown,
        agentNameRaw: unknown,
        agentPresentRaw: unknown,
      ) => {
        const terminalActivity = activityRaw as TerminalActivity
        const agentName = (agentNameRaw as string | null) ?? null
        const agentPresent = agentPresentRaw === true

        // terminal->workspace identity is owned by terminalRegistry's bimap. The
        // terminal is registered in THIS window (it owns it), so the resolve
        // succeeds; fall back to the selected workspace only as a safety net.
        const actualWorkspaceId =
          workspaceIdForTerminal(terminalId) ?? useAppStore.getState().selectedWorkspaceId
        if (!actualWorkspaceId) return

        // statusStore is the single home for (agentName, agentPresent). Read the
        // PRIOR name from there (not a separate module map) so the rising-edge
        // tab-title push fires once when the name first appears.
        const prevAgent =
          useStatusStore.getState().workspaces[actualWorkspaceId]?.terminals[terminalId]?.agentName ?? null

        store().setTerminalActivity(actualWorkspaceId, terminalId, terminalActivity)
        store().setAgentPresent(actualWorkspaceId, terminalId, agentPresent)
        store().setAgentName(actualWorkspaceId, terminalId, agentName)
        // Running-state is derived from the agent's title spinner; feed presence
        // into the coordinator for the notRunning/finished edges. The name is
        // already in statusStore (above), which the coordinator reads at commit.
        noteAgentPresence(terminalId, agentPresent)

        // Agent tab title: show the clean detected agent name (e.g. "Codex",
        // "Claude Code") on the rising edge. This is the canonical tab label
        // for agent terminals — the raw OSC title (cwd / spinner-prefixed name
        // / session label) is suppressed for agents in terminalRegistry's
        // onTitleChange (see applyOscTitleIfNoAgent), so this name sticks.
        // Duplicates are numbered ("Claude Code 2") by updatePanelTitleFromAgent.
        // It also skips the update when the user has manually renamed the tab.
        if (agentName && agentName !== prevAgent) {
          const panelId = terminalRegistry.panelIdForPty(terminalId) ?? terminalId
          useAppStore.getState().updatePanelTitleFromAgent(actualWorkspaceId, panelId, agentName)
        }
      },
    )

    return () => { unsubscribe() }
  }, [])

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onShellPortsUpdate) return
    const unsubscribe = api.onShellPortsUpdate((terminalId: string, ports: number[]) => {
      useStatusStore.getState().setTerminalPorts(terminalId, ports)
    })
    return () => { unsubscribe() }
  }, [])

  // Agent-session stamps for terminal restore: main probes the agent CLI's
  // session store while an agent runs in a terminal and sends the (deduped)
  // result here; it lands on the terminal's PanelState, which persists into
  // session.json. On restore, TerminalPanel types the resume command into the
  // fresh shell. Null clears the stamp (the agent exited).
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onShellAgentSessionUpdate) return
    const unsubscribe = api.onShellAgentSessionUpdate((terminalId, session) => {
      const workspaceId =
        workspaceIdForTerminal(terminalId) ?? useAppStore.getState().selectedWorkspaceId
      if (!workspaceId) return
      const panelId = terminalRegistry.panelIdForPty(terminalId) ?? terminalId
      useAppStore.getState().setPanelAgentSession(workspaceId, panelId, session)
    })
    return () => { unsubscribe() }
  }, [])

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onShellCwdUpdate) return
    const unsubscribe = api.onShellCwdUpdate((terminalId: string, cwd: string) => {
      useStatusStore.getState().setTerminalCwd(terminalId, cwd)
    })
    return () => { unsubscribe() }
  }, [])
}

export function useProcessMonitor(workspaceId: string): void {
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onGitBranchUpdate) return
    // GIT_BRANCH_UPDATE is a pure invalidation signal; the live git facts
    // (branch/ahead/behind/worktree list) are refetched by gitStatusStore, which
    // owns its own GIT_BRANCH_UPDATE subscription. Here we only reconcile the
    // UI-owned worktree metadata in appStore so a worktree created without the
    // parallel-work sidebar open still gets an id/color and shows up on the
    // canvas (territories/pills). The git monitor debounces this signal, so the
    // cheap `git worktree list` reconcile runs only when something changed.
    const unsubscribe = api.onGitBranchUpdate((evWorkspaceId: string) => {
      void syncWorktrees(evWorkspaceId).catch((err) => {
        log.debug('[worktree-sync] background reconcile failed', err)
      })
    })
    return () => { unsubscribe() }
  }, [])

  // Initial sync for the active workspace, so worktrees are fresh at app start
  // (and on workspace switch) even before the first GIT_BRANCH_UPDATE lands.
  useEffect(() => {
    void syncWorktrees(workspaceId).catch((err) => {
      log.debug('[worktree-sync] initial reconcile failed', err)
    })
  }, [workspaceId])

  // Re-arm whenever this workspace's runtime becomes ready. During a
  // background restore the renderer can fire GIT_MONITOR_START before a remote
  // runtime finishes connecting; the main handler throws on an unconnected id
  // and never arms. Keying on `ready` lets the effect re-run once the runtime
  // flips to 'connected'. For local workspaces `ready` is true immediately, so
  // behavior is unchanged.
  const ready = useAppStore((s) =>
    isWorkspaceMonitorReady(s.workspaces.find((w) => w.id === workspaceId)),
  )
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.gitMonitorStart) return
    if (!ready) return
    const ws = useAppStore.getState().getWorkspace(workspaceId)
    if (ws?.rootPath) {
      api.gitMonitorStart(workspaceId, ws.rootPath)
    }
    return () => { api.gitMonitorStop?.(workspaceId) }
  }, [workspaceId, ready])
}
