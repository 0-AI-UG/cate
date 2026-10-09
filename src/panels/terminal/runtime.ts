// What the daemon composition root needs for terminal panels: the definition,
// the session class bound to its deps, and the terminals port started agents
// run in.

import type { AgentStartPorts } from '@services/agents/runtime'
import type { LaunchIntent } from '@services/terminal/contract'
import type { PanelKit } from '@panels/framework/contract'
import type { DisposeReason, PanelSessionClass, SessionKit } from '@panels/framework/runtime'
import type { PanelRecord } from '@workspace/document/contract'
import { terminalDefinition } from './definition'
import { TerminalSession, type TerminalSessionDeps } from './session'

export { terminalDefinition } from './definition'
export {
  TerminalSession,
  type SessionTerminalService,
  type TerminalSessionDeps,
} from './session'

export interface TerminalPanels {
  definition: typeof terminalDefinition
  session: PanelSessionClass
  /** The live session of a terminal panel. */
  sessionOf(panelId: string): TerminalSession | undefined
  /** The terminals started agents run in (agents runtime `AgentStartPorts`). */
  agentTerminals(kit: PanelKit, host: { started(panelId: string): Promise<void> }): AgentStartPorts['terminals']
}

export function createTerminalPanels(deps: Omit<TerminalSessionDeps, 'takeLaunch'>): TerminalPanels {
  const launches = new Map<string, LaunchIntent>()
  const live = new Map<string, TerminalSession>()

  class BoundTerminalSession extends TerminalSession {
    constructor(kit: SessionKit, record: PanelRecord) {
      super(kit, record, {
        ...deps,
        takeLaunch: (panelId) => {
          const launch = launches.get(panelId)
          launches.delete(panelId)
          return launch
        },
      })
    }

    override start(): Promise<void> {
      live.set(this.panelId, this)
      return super.start()
    }

    protected override release(reason: DisposeReason): void {
      if (live.get(this.panelId) === this) live.delete(this.panelId)
      super.release(reason)
    }
  }

  const liveSession = (panelId: string): TerminalSession => {
    const session = live.get(panelId)
    if (!session) throw new Error(`terminal ${panelId} is gone`)
    return session
  }

  return {
    definition: terminalDefinition,
    session: BoundTerminalSession as unknown as PanelSessionClass,
    sessionOf: (panelId) => live.get(panelId),
    agentTerminals: (kit, host) => ({
      async create({ cwd, worktreeId, title, launch, placement }) {
        const id = kit.newId()
        launches.set(id, launch)
        const record = kit.record('terminal', { id, title: kit.uniqueTitle(title, id), worktreeId, fields: { cwd } })
        if (!kit.add(record, placement)) {
          launches.delete(id)
          throw new Error('could not place the terminal')
        }
        await host.started(id)
        const snapshot = liveSession(id).snapshot()
        if (snapshot.status === 'failed') throw new Error(snapshot.error ?? 'terminal failed to start')
        return id
      },
      relaunch: (panelId, { cwd, worktreeId, launch }) => liveSession(panelId).launch(launch, { cwd, worktreeId }),
      state(panelId) {
        const session = live.get(panelId)
        if (!session) return null
        return { alive: session.snapshot().status === 'running', busy: session.busy() }
      },
    }),
  }
}
