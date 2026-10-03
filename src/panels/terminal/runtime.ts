// What the daemon composition root needs for terminal panels: the definition,
// the session class bound to its deps, and the terminals port missions drive
// workers through.

import type { MissionTerminals } from '@services/agents/runtime'
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
  type TerminalAgentRunner,
  type TerminalSessionDeps,
} from './session'

export interface TerminalPanels {
  definition: typeof terminalDefinition
  session: PanelSessionClass
  /** The live session of a terminal panel. */
  sessionOf(panelId: string): TerminalSession | undefined
  /** Missions' view of terminal panels (agents runtime `MissionTerminals`). */
  missionTerminals(kit: PanelKit, host: { started(panelId: string): Promise<void> }): MissionTerminals
}

export function createTerminalPanels(deps: Omit<TerminalSessionDeps, 'takeLaunch'>): TerminalPanels {
  const launches = new Map<string, LaunchIntent>()
  const live = new Map<string, TerminalSession>()
  const listeners = new Set<() => void>()
  const changed = () => { for (const listener of [...listeners]) listener() }

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
      this.attach({ snapshot() {}, change: changed, bytes() {}, gone() {} })
      return super.start()
    }

    protected override release(reason: DisposeReason): void {
      if (live.get(this.panelId) === this) live.delete(this.panelId)
      super.release(reason)
      changed()
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
    missionTerminals: (kit, host) => ({
      async create({ cwd, worktreeId, title, launch, at }) {
        const id = kit.newId()
        launches.set(id, launch)
        const record = kit.record('terminal', { id, title: kit.uniqueTitle(title, id), worktreeId, fields: { cwd } })
        if (!kit.add(record, at ? { at } : undefined)) {
          launches.delete(id)
          throw new Error('could not place the terminal')
        }
        await host.started(id)
        const snapshot = liveSession(id).snapshot()
        if (snapshot.status === 'failed') throw new Error(snapshot.error ?? 'terminal failed to start')
        return id
      },
      relaunch: (panelId, { cwd, worktreeId, launch }) => liveSession(panelId).launch(launch, { cwd, worktreeId }),
      isTerminal: (panelId) => live.has(panelId),
      state(panelId) {
        const session = live.get(panelId)
        const snapshot = session?.snapshot()
        return {
          started: !!snapshot && snapshot.status !== 'starting',
          alive: snapshot?.status === 'running',
          failure: snapshot?.error ?? null,
          cwd: snapshot?.cwd ?? null,
          busy: session?.busy() ?? false,
        }
      },
      tail: async (panelId) => (await liveSession(panelId).read(80)).text,
      terminate: (panelId) => live.get(panelId)?.terminate(),
      onChange(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }),
  }
}
