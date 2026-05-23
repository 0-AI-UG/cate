import { terminalRegistry } from './terminalRegistry'
import { useStatusStore } from '../stores/statusStore'
import { sendOsNotification } from './osNotifications'
import { decideNotification } from '../hooks/notificationTransitions'
import { createNotificationDebouncer } from '../hooks/notificationDebouncer'
import {
  computeRawState,
  applyHysteresis,
  POLL_MS,
  type HysteresisState,
} from './agentScreenDetectorLogic'
import type { AgentState } from '../../shared/types'

const WAITING_FOR_INPUT_DEBOUNCE_MS = 3500

interface Tracker {
  lastReported: AgentState | null
  pendingWaitingSince: number | null
  wasAgentPresent: boolean
}

const trackers = new Map<string, Tracker>()

let waitingDebouncer: ReturnType<typeof createNotificationDebouncer<{
  title: string
  body: string
  action: { type: 'focusTerminal'; workspaceId: string; terminalId: string }
}>> | null = null

function trackerFor(ptyId: string): Tracker {
  let t = trackers.get(ptyId)
  if (!t) {
    t = {
      lastReported: null,
      pendingWaitingSince: null,
      wasAgentPresent: false,
    }
    trackers.set(ptyId, t)
  }
  return t
}

function disposeTracker(ptyId: string): void {
  trackers.delete(ptyId)
}

let intervalHandle: ReturnType<typeof setInterval> | null = null

function tick(): void {
  const now = Date.now()
  const status = useStatusStore.getState()
  const api = window.electronAPI
  const alivePtyIds = new Set<string>()

  for (const [, entry] of terminalRegistry.entries()) {
    const ptyId = entry.ptyId
    if (!ptyId) continue
    alivePtyIds.add(ptyId)

    const workspaceId = status.terminalWorkspaceMap[ptyId]
    if (!workspaceId) continue
    const ws = status.workspaces[workspaceId]
    if (!ws) continue

    const agentPresent = ws.agentPresent[ptyId] === true
    const agentName = ws.agentName[ptyId] ?? null

    if (!agentPresent && !trackers.has(ptyId)) continue

    const t = trackerFor(ptyId)

    const subprocessActive = ws.subprocessActive[ptyId] === true
    const rawState = computeRawState({
      agentPresent,
      wasAgentPresent: t.wasAgentPresent,
      subprocessActive,
    })

    t.wasAgentPresent = agentPresent

    const hstate: HysteresisState = t
    const state = applyHysteresis(rawState, hstate, now)

    if (t.lastReported === state) continue

    const prevState = t.lastReported ?? 'notRunning'
    t.lastReported = state
    status.setAgentState(workspaceId, ptyId, state, agentName)
    api?.shellReportAgentScreenState?.(ptyId, state)

    const displayName = agentName ?? 'Agent'
    const action = { type: 'focusTerminal' as const, workspaceId, terminalId: ptyId }
    const kind = decideNotification(prevState, state)

    if (kind === 'waitingForInput') {
      waitingDebouncer?.request(ptyId, {
        title: `${displayName} needs input`,
        body: `${displayName} is waiting for your response.`,
        action,
      })
    } else if (kind === 'finished') {
      waitingDebouncer?.cancel(ptyId)
      sendOsNotification({
        title: 'Task complete',
        body: `${displayName} has finished running.`,
        action,
      })
    } else if (state !== 'waitingForInput' && prevState === 'waitingForInput') {
      waitingDebouncer?.cancel(ptyId)
    }

    if (state === 'finished' || state === 'notRunning') {
      disposeTracker(ptyId)
    }
  }

  for (const ptyId of trackers.keys()) {
    if (!alivePtyIds.has(ptyId)) disposeTracker(ptyId)
  }
}

export function startAgentScreenDetector(): void {
  if (intervalHandle) return
  waitingDebouncer = createNotificationDebouncer(
    WAITING_FOR_INPUT_DEBOUNCE_MS,
    (payload) => sendOsNotification(payload),
  )
  intervalHandle = setInterval(tick, POLL_MS)
}

export function stopAgentScreenDetector(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  waitingDebouncer?.dispose()
  waitingDebouncer = null
  for (const ptyId of Array.from(trackers.keys())) disposeTracker(ptyId)
}

export function applyRemoteAgentScreenState(ptyId: string, state: AgentState): void {
  const status = useStatusStore.getState()
  const workspaceId = status.terminalWorkspaceMap[ptyId]
  if (!workspaceId) return
  const agentName = status.workspaces[workspaceId]?.agentName[ptyId] ?? null
  status.setAgentState(workspaceId, ptyId, state, agentName)
}
