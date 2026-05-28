import { useEffect } from 'react'
import { useStatusStore } from '../stores/statusStore'
import { useAppStore } from '../stores/appStore'
import { terminalRegistry } from '../lib/terminalRegistry'
import { noteAgentPresence } from '../lib/agentScreenDetector'
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
      (workspaceId: string, branch: string, isDirty: boolean) => {
        useStatusStore.getState().setGitInfo(workspaceId, branch, isDirty)
      },
    )
    return () => { unsubscribe() }
  }, [])

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.gitMonitorStart) return
    const ws = useAppStore.getState().getWorkspace(workspaceId)
    if (ws?.rootPath) {
      api.gitMonitorStart(workspaceId, ws.rootPath)
    }
    return () => { api.gitMonitorStop?.(workspaceId) }
  }, [workspaceId])
}
