import {
  createMissions,
  resolveDriverAgent,
  type AgentsRuntime,
  type Missions,
  type MissionStore,
  type MissionTerminals,
  type MissionWorktrees,
} from '../../runtime'
import type { TerminalRunner } from './terminalRunner'

/** Missions whose workers run through the terminal runner. */
export function createTerminalMissions(
  agents: AgentsRuntime,
  runner: TerminalRunner,
  ports: { terminals: MissionTerminals; worktrees: MissionWorktrees; store?: MissionStore },
): Missions & { dispose(): void } {
  const missions = createMissions({
    root: agents.root,
    terminals: ports.terminals,
    worktrees: ports.worktrees,
    store: ports.store,
    worktreePath: (worktreeId) => agents.document.worktreePath(worktreeId),
    panelWorktree: (panelId) => agents.document.panel(panelId)?.worktreeId,
    agentState: (panelId) => runner.state(panelId),
    submit: (panelId, prompt) => runner.submit(panelId, prompt),
    async resolveAgent(cwd, preferred) {
      agents.trust.requireTrusted()
      const agent = await resolveDriverAgent((dir) => agents.hooks.inspectWorkspace(dir), cwd, preferred, {
        fallbackCwd: agents.root,
        hookConfig: agents.settings.agentHookInjection(),
      })
      return agent.id
    },
  })
  const offExit = runner.onExit((panelId, exitCode) => missions.noteExit(panelId, exitCode))
  const offStates = agents.registry.subscribe(() => missions.notifyChanged())
  return {
    ...missions,
    dispose() {
      offExit()
      offStates()
    },
  }
}
