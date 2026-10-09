// The core API for agents in a workspace: their conversations (followed live,
// conversations.ts), prompts and interrupts, starting one in a terminal or in
// T3 (`cate.agent.start`) and its changes in a review panel; keep-awake and
// pushes. Failures come back as words.

import { runtimeFor } from '@kernel/rpc/client'
import { isRpcError } from '@kernel/rpc/contract'
import { openAgentChanges } from '@panels/review/client'
import type { MobileActionResult, MobileCoreMethods } from '../contract'
import type { MobileAgents } from './agents'
import type { MobileConversations } from './conversations'
import { placementOptions } from './placement'

type Handlers<M extends keyof MobileCoreMethods> = {
  [K in M]: (params: MobileCoreMethods[K]['params']) => Promise<MobileCoreMethods[K]['result']>
}

export type ActionMethod =
  | 'agents.watch' | 'agents.unwatch' | 'agents.send' | 'agents.interrupt'
  | 'agents.choices' | 'agents.t3Models' | 'agents.start' | 'agents.review'
  | 'power.set' | 'push.device' | 'push.useCateConnect'

/** The runtime's error codes in the words the app shows. */
const WORDS: Record<string, string> = {
  'agent-busy': 'The agent is in the middle of a turn.',
  'agent-not-running': 'The agent is not running.',
  'agent-panel-not-found': 'The agent\'s panel was closed.',
  'agent-panel-unavailable': 'The agent\'s panel is not available.',
  'prompt-required': 'Describe the task first.',
  't3-provider-not-ready': 'That T3 Code provider is not ready on your computer.',
  't3-project-not-found': 'T3 Code is still opening this checkout. Try again in a moment.',
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

/** A worktree name for a task: its first words, and a suffix so two tasks
 *  with the same start do not collide. */
export function taskWorktreeName(prompt: string, suffix = Math.random().toString(36).slice(2, 6)): string {
  const words = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '')
  return `task-${words || 'work'}-${suffix}`
}

export function createActionHandlers(agents: MobileAgents, conversations: MobileConversations): Handlers<ActionMethod> {
  return {
    async 'agents.watch'(params) {
      conversations.watch(params)
      return null
    },
    async 'agents.unwatch'({ viewId }) {
      conversations.unwatch(viewId)
      return null
    },
    async 'agents.send'({ viewId, workspaceId, panelId, prompt }) {
      conversations.sent(viewId, prompt)
      const result = await attempt(() => runtimeFor(workspaceId).agents.send({ panelId, prompt }))
      if (!result.ok) conversations.unsent(viewId)
      return result
    },
    'agents.interrupt': ({ workspaceId, panelId }) =>
      attempt(() => runtimeFor(workspaceId).agents.interrupt({ panelId })),
    async 'agents.choices'({ workspaceId }) {
      return runtimeFor(workspaceId).agents.types().catch(() => [])
    },
    async 'agents.t3Models'({ workspaceId }) {
      return runtimeFor(workspaceId).t3.providerModels().catch(() => [])
    },
    async 'agents.start'({ workspaceId, prompt, launch, worktree, placement }) {
      const { near, position } = placementOptions(launch.runner === 'terminal' ? 'terminal' : 'chat', placement)
      try {
        const started = await runtimeFor(workspaceId).agents.start({
          prompt,
          ...(launch.runner === 'terminal'
            ? { runner: 'terminal' as const, agentId: launch.agentId }
            : { runner: 't3' as const, instanceId: launch.instanceId, model: launch.model }),
          ...(worktree ? { newWorktree: taskWorktreeName(prompt) } : {}),
          ...(near ? { canvasPanelId: near } : {}),
          ...(position ? { position } : {}),
        })
        return { ok: true, panelId: started.panelId }
      } catch (error) {
        return { ok: false, message: wordsFor(error) }
      }
    },
    async 'agents.review'({ workspaceId, panelId }) {
      return openAgentChanges({ workspaceId, panelId })
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
