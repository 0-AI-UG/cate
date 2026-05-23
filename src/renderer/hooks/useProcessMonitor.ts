import { useEffect } from 'react'
import { useStatusStore } from '../stores/statusStore'
import { useAppStore } from '../stores/appStore'
import type { TerminalActivity } from '../../shared/types'

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
        subprocessActiveRaw: unknown,
        agentPresentRaw: unknown,
      ) => {
        const terminalActivity = activityRaw as TerminalActivity
        const agentName = (agentNameRaw as string | null) ?? null
        const subprocessActive = subprocessActiveRaw === true
        const agentPresent = agentPresentRaw === true

        const actualWorkspaceId =
          useStatusStore.getState().terminalWorkspaceMap[terminalId] ?? workspaceId

        store().setTerminalActivity(actualWorkspaceId, terminalId, terminalActivity)
        store().setSubprocessActive(actualWorkspaceId, terminalId, subprocessActive)
        store().setAgentPresent(actualWorkspaceId, terminalId, agentPresent)
        store().setAgentName(actualWorkspaceId, terminalId, agentName)
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
