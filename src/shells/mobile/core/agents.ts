// The agents of every connected workspace, live, for the agents home and the
// session view: each panel's agent state (the `agents.panels` channel), what
// it last asked for (the notification events every client consumes; the
// core's gate decides which reach the app as banners), keep-awake and this
// device's push registration.

import { mirrorChannel, type ChannelMirror } from '@kernel/rpc/client'
import { eachConnection, type WorkspaceConnection } from '@client/connections'
import { documentStoreFor } from '@client/document'
import type { PowerState } from '@runtime/power/contract'
import { pushCollapseId, type PushStatus } from '@runtime/push/contract'
import { acquireAgentPanels, onAgentsWorking } from '@services/agents/client'
import { attachNotifications, createNotificationGate } from '@workspace/notifications/client'
import type { AgentPanelStates, AgentStatus } from '@services/agents/contract'
import type { MobileAgent, MobileBridge } from '../contract'
import type { MobileClient } from './boot'

export interface PushDevice {
  target: string
  key: string
}

export interface MobileAgents {
  agents(workspaceId: string): MobileAgent[]
  power(workspaceId: string): PowerState | null
  push(workspaceId: string): PushStatus | null
  /** Where this device's pushes go: registered with every connected workspace. */
  setPushDevice(device: PushDevice): void
  /** Reads the workspace's push status again (after its network changed). */
  refreshPush(workspaceId: string): void
  subscribe(listener: () => void): () => void
}

interface Live {
  states: AgentPanelStates
  /** What each panel's agent last asked for, until it works again. */
  attention: Map<string, string>
  since: Map<string, { status: AgentStatus; at: number }>
  power: PowerState | null
  push: PushStatus | null
  refreshPush(): void
}

/** How often push status is read again while pushes are blocked: Cate
 *  Connect registers a moment after network access changes. */
const PUSH_RETRY_MS = 15_000

export function createMobileAgents(client: MobileClient, bridge: MobileBridge): MobileAgents {
  const live = new Map<string, Live>()
  const listeners = new Set<() => void>()
  let device: PushDevice | null = null

  const changed = () => {
    for (const listener of [...listeners]) listener()
  }

  const runtimeIdOf = (workspaceId: string): string => {
    const entry = client.workspaces.getSnapshot().entries.find((candidate) => candidate.id === workspaceId)
    return entry?.kind === 'paired' ? entry.runtimeId : workspaceId
  }

  const attach = (connection: WorkspaceConnection): (() => void) => {
    const { workspaceId, runtime } = connection
    const offs: Array<() => void> = []
    let disposed = false
    const entry: Live = {
      states: {},
      attention: new Map(),
      since: new Map(),
      power: null,
      push: null,
      refreshPush: () => {},
    }
    live.set(workspaceId, entry)

    const panels = acquireAgentPanels(workspaceId)
    const takeStates = () => {
      entry.states = panels.getSnapshot()
      const now = Date.now()
      for (const [panelId, state] of Object.entries(entry.states)) {
        if (entry.since.get(panelId)?.status !== state.status) entry.since.set(panelId, { status: state.status, at: now })
      }
      changed()
    }
    offs.push(panels.subscribe(takeStates), () => panels.release())

    // Opened again on every connect: a stream that failed before its first
    // event (a runtime of another build, mid-update) is not reopened.
    let power: ChannelMirror<PowerState> | null = null
    const watchPower = () => {
      power?.dispose()
      power = mirrorChannel(() => runtime.power.subscribe(undefined, { resume: true }))
      power.subscribe((state) => {
        entry.power = state?.snapshot ?? null
        changed()
      })
    }
    offs.push(() => power?.dispose())

    let pushTimer: ReturnType<typeof setTimeout> | null = null
    entry.refreshPush = () => {
      if (pushTimer) clearTimeout(pushTimer)
      pushTimer = null
      if (!device || disposed) return
      const { target, key } = device
      runtime.push.register({ target, key }).then((status) => {
        if (disposed) return
        entry.push = status
        changed()
        if (status.blocked) pushTimer = setTimeout(entry.refreshPush, PUSH_RETRY_MS)
      }, () => {})
    }
    offs.push(() => { if (pushTimer) clearTimeout(pushTimer) })

    // On every (re)connect: keep-awake and this device's registration.
    let wasConnected = false
    const onConnection = () => {
      const connected = connection.getState().kind === 'connected'
      if (connected && !wasConnected) {
        watchPower()
        entry.refreshPush()
      }
      wasConnected = connected
    }
    offs.push(connection.subscribe(onConnection))
    onConnection()
    takeStates()

    return () => {
      disposed = true
      for (const off of offs.splice(0)) off()
      if (live.get(workspaceId) === entry) live.delete(workspaceId)
      changed()
    }
  }

  eachConnection(client.connections, attach)

  // Notification events, consumed as every client consumes them: what a
  // panel asked for shows on its agent until it works again, and the gate
  // (this device's settings and whether the app is in front) decides which
  // become banners.
  const gate = createNotificationGate({
    settings: () => ({
      notificationsEnabled: client.settings.get('notificationsEnabled'),
      notifyOnlyWhenUnfocused: client.settings.get('notifyOnlyWhenUnfocused'),
    }),
    isFocused: () => client.isActive(),
    show(workspaceId, event) {
      void bridge('notification.show', {
        id: pushCollapseId(runtimeIdOf(workspaceId), event.panelId, Date.now()),
        workspaceId,
        panelId: event.panelId ?? null,
        kind: event.kind,
        title: event.title,
        body: event.body,
      }).catch(() => {})
    },
  })
  attachNotifications(client.connections, (workspaceId, event) => {
    const entry = live.get(workspaceId)
    if (entry && event.panelId) entry.attention.set(event.panelId, event.body)
    changed()
    gate.show(workspaceId, event)
  })
  onAgentsWorking(client.connections, (workspaceId, panelId) => {
    gate.cancel(workspaceId, panelId)
    if (!live.get(workspaceId)?.attention.delete(panelId)) return
    changed()
    void bridge('notification.withdraw', { id: pushCollapseId(runtimeIdOf(workspaceId), panelId, 0) }).catch(() => {})
  })

  return {
    agents(workspaceId) {
      const entry = live.get(workspaceId)
      if (!entry) return []
      const doc = documentStoreFor(workspaceId)?.getSnapshot()
      return Object.values(entry.states).flatMap((state): MobileAgent[] => {
        const panel = doc?.panels[state.panelId]
        if (!panel) return []
        return [{
          panelId: state.panelId,
          panelType: panel.type,
          title: panel.title || state.agentName || 'Agent',
          agentId: state.agentId,
          agentName: state.agentName,
          status: state.status,
          present: state.present,
          canReceivePrompt: state.canReceivePrompt,
          attention: state.status === 'waitingForInput' ? entry.attention.get(state.panelId) ?? null : null,
          since: entry.since.get(state.panelId)?.at ?? Date.now(),
          checkout: state.session?.cwd ?? (panel.worktreeId ? doc?.worktrees[panel.worktreeId]?.path ?? null : null),
        }]
      })
    },
    power: (workspaceId) => live.get(workspaceId)?.power ?? null,
    push: (workspaceId) => live.get(workspaceId)?.push ?? null,
    setPushDevice(next) {
      device = next
      for (const entry of live.values()) entry.refreshPush()
    },
    refreshPush: (workspaceId) => live.get(workspaceId)?.refreshPush(),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
