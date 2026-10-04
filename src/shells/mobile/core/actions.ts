// The core API for the agents home, the session view, the composer and
// shipping: prompts, tasks, a checkout's changes, commit,
// push and pull request, keep-awake and pushes. Failures come back as words.

import { runtimeFor } from '@kernel/rpc/client'
import { isRpcError } from '@kernel/rpc/contract'
import type { MobileActionResult, MobileCoreMethods } from '../contract'
import type { MobileAgents } from './agents'
import { agent, codingAgent } from './cateApi'

type Handlers<M extends keyof MobileCoreMethods> = {
  [K in M]: (params: MobileCoreMethods[K]['params']) => Promise<MobileCoreMethods[K]['result']>
}

export type ActionMethod =
  | 'agents.conversation' | 'agents.send'
  | 'agents.taskAgents' | 'agents.startTask' | 'agents.taskAction'
  | 'changes.list' | 'changes.diff' | 'changes.commit' | 'changes.push' | 'changes.pullRequest'
  | 'power.set' | 'push.device' | 'push.useCateConnect'

/** The runtime's error codes in the words the app shows. */
const WORDS: Record<string, string> = {
  'agent-busy': 'The agent is in the middle of a turn.',
  'agent-not-running': 'The agent is not running.',
  'agent-panel-not-found': 'The agent\'s panel was closed.',
  'agent-panel-unavailable': 'The agent\'s panel is not available.',
  'coding-agent-limit': 'Five tasks are already running. Wait for one to finish.',
  'coding-agent-not-ready': 'The task is not finished yet.',
  'worker-does-not-own-worktree': 'This task\'s worktree was not created for it, so it is kept.',
  'prompt-required': 'Describe the task first.',
  untrusted: 'Trust this workspace on your computer first.',
}

export function wordsFor(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (WORDS[message]) return WORDS[message]
  if (isRpcError(error) && WORDS[error.code]) return WORDS[error.code]
  return message
}

const ok: MobileActionResult = { ok: true }

async function attempt(work: () => Promise<unknown>): Promise<MobileActionResult> {
  try {
    await work()
    return ok
  } catch (error) {
    return { ok: false, message: wordsFor(error) }
  }
}

const cwdOf = (checkout: string | null) => (checkout ? { cwd: checkout } : {})

/** A worktree name for a task: its first words, and a suffix so two tasks
 *  with the same start do not collide. */
export function taskWorktreeName(prompt: string, suffix = Math.random().toString(36).slice(2, 6)): string {
  const words = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '')
  return `task-${words || 'work'}-${suffix}`
}

export function createActionHandlers(agents: MobileAgents): Handlers<ActionMethod> {
  return {
    async 'agents.conversation'({ workspaceId, panelId }) {
      // No session yet, or the agent exited: nothing to read.
      const read = await agent(runtimeFor(workspaceId), 'read', { panelId }).catch(() => null)
      return read ? read.messages : null
    },
    'agents.send': ({ workspaceId, panelId, prompt }) =>
      attempt(() => agent(runtimeFor(workspaceId), 'send', { targetPanelId: panelId, prompt })),
    async 'agents.taskAgents'({ workspaceId }) {
      return codingAgent(runtimeFor(workspaceId), 'agents', {}).catch(() => [])
    },
    async 'agents.startTask'({ workspaceId, prompt, agentId, worktree }) {
      try {
        const run = await codingAgent(runtimeFor(workspaceId), 'create', {
          prompt,
          ...(agentId ? { agentId } : {}),
          ...(worktree ? { newWorktree: taskWorktreeName(prompt) } : {}),
        })
        agents.refreshTasks(workspaceId)
        return { ok: true, panelId: run.panelId }
      } catch (error) {
        return { ok: false, message: wordsFor(error) }
      }
    },
    async 'agents.taskAction'({ workspaceId, taskId, action }) {
      const result = await attempt(() => codingAgent(runtimeFor(workspaceId), action, { runId: taskId }))
      agents.refreshTasks(workspaceId)
      return result
    },

    async 'changes.list'({ workspaceId, checkout }) {
      const result = await runtimeFor(workspaceId).vcs.compare({ ...cwdOf(checkout), spec: { kind: 'uncommitted' } })
      return {
        branch: result.currentBranch,
        files: result.files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })),
        additions: result.additions,
        deletions: result.deletions,
      }
    },
    'changes.diff': ({ workspaceId, checkout, path }) =>
      runtimeFor(workspaceId).vcs.fileDiff({ ...cwdOf(checkout), spec: { kind: 'uncommitted' }, path }),
    async 'changes.commit'({ workspaceId, checkout, message }) {
      const vcs = runtimeFor(workspaceId).vcs
      return attempt(async () => {
        await vcs.stageAll(cwdOf(checkout))
        await vcs.commit({ ...cwdOf(checkout), message })
      })
    },
    'changes.push': ({ workspaceId, checkout }) => attempt(() => runtimeFor(workspaceId).vcs.push(cwdOf(checkout))),
    async 'changes.pullRequest'({ workspaceId, checkout }) {
      const vcs = runtimeFor(workspaceId).vcs
      try {
        const branch = (await vcs.compare({ ...cwdOf(checkout), spec: { kind: 'uncommitted' } })).currentBranch
        if (!branch) return { ok: false, message: 'The checkout is not on a branch.' }
        const path = checkout ?? (await runtimeFor(workspaceId).runtime.info()).root
        const result = await vcs.createPr({ path, branch })
        return result.ok ? { ok: true, url: result.url } : { ok: false, message: result.message }
      } catch (error) {
        return { ok: false, message: wordsFor(error) }
      }
    },

    'power.set': ({ workspaceId, duration }) => attempt(() => runtimeFor(workspaceId).power.set({ duration })),
    async 'push.device'(device) {
      agents.setPushDevice(device)
      return null
    },
    async 'push.useCateConnect'({ workspaceId }) {
      const result = await attempt(() => runtimeFor(workspaceId).settings.set({ key: 'runtimeNetwork', value: 'cateConnect' }))
      agents.refreshPush(workspaceId)
      return result
    },
  }
}
