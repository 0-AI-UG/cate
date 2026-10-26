// The core API for agents in a workspace: their conversations (followed live,
// conversations.ts), prompts and interrupts, starting one in a terminal
// (`cate.agent.start`) and its changes in a review panel; keep-awake and
// pushes. Failures come back as words.

import { runtimeFor } from '@kernel/rpc/client'
import { isRpcError } from '@kernel/rpc/contract'
import { openAgentChanges } from '@panels/review/client'
import { fsClient } from '@workspace/files/client'
import { base64ToBytes } from '@workspace/files/contract'
import type { MobileActionResult, MobileCoreMethods } from '../contract'
import type { MobileAgents } from './agents'
import { NOT_TAKEN } from './chatTimeline'
import type { MobileConversations } from './conversations'
import { placementOptions } from './placement'

type Handlers<M extends keyof MobileCoreMethods> = {
  [K in M]: (params: MobileCoreMethods[K]['params']) => Promise<MobileCoreMethods[K]['result']>
}

export type ActionMethod =
  | 'agents.watch' | 'agents.unwatch' | 'agents.more' | 'agents.send' | 'agents.withdraw' | 'agents.attach' | 'agents.interrupt'
  | 'agents.choices' | 'agents.start' | 'agents.review'
  | 'power.set' | 'push.device' | 'push.useCateConnect'

/** The runtime's error codes in the words the app shows. */
const WORDS: Record<string, string> = {
  'agent-busy': 'The agent is in the middle of a turn.',
  'agent-not-running': 'The agent is not running.',
  'agent-panel-not-found': 'The agent\'s panel was closed.',
  'agent-panel-unavailable': 'The agent\'s panel is not available.',
  'agent-prompt-not-taken': NOT_TAKEN,
  'prompt-required': 'Say what to work on first.',
  untrusted: 'Trust this workspace on your computer first.',
}

export function wordsFor(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (WORDS[message]) return WORDS[message]
  // A code with a hint after it (`agent-prompt-not-taken: ...`).
  const code = message.split(':')[0]
  if (code !== message && WORDS[code]) return WORDS[code]
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

/** A worktree name for a new agent: its prompt's first words, and a suffix
 *  so two agents with the same start do not collide. */
export function agentWorktreeName(prompt: string, suffix = Math.random().toString(36).slice(2, 6)): string {
  const words = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '')
  return `agent-${words || 'work'}-${suffix}`
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
    async 'agents.more'({ viewId }) {
      conversations.more(viewId)
      return null
    },
    'agents.send': ({ workspaceId, panelId, prompt, attachments }) =>
      attempt(() => runtimeFor(workspaceId).agents.send({ panelId, prompt, ...(attachments?.length ? { attachments } : {}) })),
    async 'agents.withdraw'({ workspaceId, panelId, promptId }) {
      return runtimeFor(workspaceId).agents.withdraw({ panelId, promptId }).catch(() => null)
    },
    async 'agents.attach'({ workspaceId, name, kind, data }) {
      try {
        const files = fsClient(workspaceId)
        const bytes = base64ToBytes(data)
        const { path } = kind === 'image' ? await files.storeScreenshot(name, bytes) : await files.storeDownload(name, bytes)
        return { ok: true, path }
      } catch (error) {
        return { ok: false, message: wordsFor(error) }
      }
    },
    'agents.interrupt': ({ workspaceId, panelId }) =>
      attempt(() => runtimeFor(workspaceId).agents.interrupt({ panelId })),
    async 'agents.choices'({ workspaceId }) {
      return runtimeFor(workspaceId).agents.types().catch(() => [])
    },
    async 'agents.start'({ workspaceId, prompt, attachments, agentId, worktree, placement }) {
      const { near, position } = placementOptions('terminal', placement)
      try {
        const started = await runtimeFor(workspaceId).agents.start({
          prompt,
          ...(attachments?.length ? { attachments } : {}),
          agentId,
          ...(worktree ? { newWorktree: agentWorktreeName(prompt) } : {}),
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
