import { useEffect } from 'react'
import { useStatusStore } from '../stores/statusStore'
import { useAppStore } from '../stores/appStore'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { noteAgentPresence } from '../lib/agent/agentScreenDetector'
import { isWorkspaceMonitorReady } from './workspaceMonitorReady'
import { syncWorktrees } from '../lib/worktreeSync'
import log from '../lib/logger'
import type { TerminalActivity } from '../../shared/types'

/** Last agent name we observed per terminal — module-level so we only push a
 *  panel-title fallback on the rising edge (null → "Codex") instead of every
 *  activity tick. Cleared when the renderer unregisters the terminal so the
 *  map stays bounded across long dev sessions. */
const lastAgentName: Map<string, string | null> = new Map()

/** Drop tracking state for a terminal. Wired into `statusStore.unregisterTerminal`
 *  so the module-level map can't grow without bound. */
export function forgetTerminalForProcessMonitor(terminalId: string): void {
  lastAgentName.delete(terminalId)
}

export function useProcessMonitor(workspaceId: string): void {
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

        const actualWorkspaceId =
          useStatusStore.getState().terminalWorkspaceMap[terminalId] ?? workspaceId

        store().setTerminalActivity(actualWorkspaceId, terminalId, terminalActivity)
        store().setAgentPresent(actualWorkspaceId, terminalId, agentPresent)
        store().setAgentName(actualWorkspaceId, terminalId, agentName)
        // Running-state is derived from the agent's title spinner; feed presence
        // (and name) into the coordinator for the notRunning/finished edges.
        noteAgentPresence(terminalId, agentPresent, agentName)

        // Agent tab title: show the clean detected agent name (e.g. "Codex",
        // "Claude Code") on the rising edge. This is the canonical tab label
        // for agent terminals — the raw OSC title (cwd / spinner-prefixed name
        // / session label) is suppressed for agents in terminalRegistry's
        // onTitleChange (see applyOscTitleIfNoAgent), so this name sticks.
        // `updatePanelTitleFromAgent` skips when the user has manually renamed.
        const prevAgent = lastAgentName.get(terminalId) ?? null
        if (agentName && agentName !== prevAgent) {
          const panelId = terminalRegistry.panelIdForPty(terminalId) ?? terminalId
          useAppStore.getState().updatePanelTitleFromAgent(actualWorkspaceId, panelId, agentName)
        }
        lastAgentName.set(terminalId, agentName)
      },
    )

    return () => { unsubscribe() }
  }, [workspaceId])

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onShellPortsUpdate) return
    const unsubscribe = api.onShellPortsUpdate((terminalId: string, ports: number[]) => {
      useStatusStore.getState().setTerminalPorts(terminalId, ports)
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

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onGitBranchUpdate) return
    const unsubscribe = api.onGitBranchUpdate(
      (evWorkspaceId: string, branch: string, isDirty: boolean) => {
        useStatusStore.getState().setGitInfo(evWorkspaceId, branch, isDirty)
        // Keep worktree metadata in sync without the parallel-work sidebar being
        // open — it also drives the canvas worktree territories/pills, so a
        // worktree created outside that tab should still appear. The git monitor's
        // fs-watcher + adaptive poll already debounce this signal, so we only run
        // the cheap `git worktree list` reconcile when something actually changed.
        void syncWorktrees(evWorkspaceId).catch((err) => {
          log.debug('[worktree-sync] background reconcile failed', err)
        })
      },
    )
    return () => { unsubscribe() }
  }, [])

  // Initial sync for the active workspace, so worktrees are fresh at app start
  // (and on workspace switch) even before the first GIT_BRANCH_UPDATE lands.
  useEffect(() => {
    void syncWorktrees(workspaceId).catch((err) => {
      log.debug('[worktree-sync] initial reconcile failed', err)
    })
  }, [workspaceId])

  // Re-arm whenever this workspace's companion becomes ready. During a
  // background restore the renderer can fire GIT_MONITOR_START before a remote
  // companion finishes connecting; the main handler throws on an unconnected id
  // and never arms. Keying on `ready` lets the effect re-run once the companion
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
