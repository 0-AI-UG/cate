import type {
  Chat,
  CodingImageAttachment,
  CodingThinkingLevel,
} from '../../shared/types'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import { useCodingStore, type CodingMessage } from './codingStore'
import { codingClient } from './codingClient'
import { resolveSessionModel } from './codingModelPrefs'
import log from '../../renderer/lib/logger'
import type { ComposerPromptMode } from '../../renderer/chat/ChatComposer'
import { agentErrorMessage } from '../../shared/agentErrorMessage'

export interface DirectChatTurnOptions {
  images?: CodingImageAttachment[]
  thinkingLevel?: CodingThinkingLevel
  autoCompactionEnabled?: boolean
  promptMode?: ComposerPromptMode
  promptModeCommand?: string
}

const creating = new Map<string, Promise<boolean>>()

export function directAgentKey(chatId: string): string {
  return `cate-direct:${chatId}`
}

export async function ensureDirectChatSession(
  chat: Chat,
  workspaceId: string,
  rootPath: string,
  cwd: string,
): Promise<boolean> {
  const panelId = directAgentKey(chat.id)
  const inFlight = creating.get(panelId)
  if (inFlight) return inFlight

  const promise = (async () => {
    const store = useCodingStore.getState()
    const existingPanel = store.panels[panelId]
    store.init(panelId)
    const model = existingPanel?.model ?? (await resolveSessionModel(chat.model)) ?? undefined
    if (model) store.setModel(panelId, model)
    if (!existingPanel && chat.sessionFile) {
      try {
        const messages = await window.electronAPI.agentLoadSessionMessages(chat.sessionFile)
        store.loadMessages(panelId, messages as CodingMessage[])
      } catch (error) {
        log.warn('[directChatSession] transcript load failed for %s: %O', panelId, error)
      }
    }
    try {
      const result = await codingClient.create({
        panelId,
        workspaceId,
        cwd,
        workspaceRoot: rootPath,
        model,
        sessionFile: chat.sessionFile ?? undefined,
      })
      if (!result.ok) {
        store.appendSystem(
          panelId,
          agentErrorMessage(
            result.error,
            'Cate couldn’t start the agent. Start a new chat and try again.',
          ),
          'error',
        )
        return false
      }
      return true
    } catch (error) {
      log.warn('[directChatSession] create failed for %s: %O', panelId, error)
      store.appendSystem(panelId, 'Failed to start the direct agent.', 'error')
      return false
    }
  })().finally(() => creating.delete(panelId))
  creating.set(panelId, promise)
  return promise
}

/** Send the first or a later turn through the chat's sole main-agent session. */
export async function promptDirectChat(
  chat: Chat,
  workspaceId: string,
  rootPath: string,
  text: string,
  options: DirectChatTurnOptions = {},
  cwd = rootPath,
): Promise<boolean> {
  const panelId = directAgentKey(chat.id)
  const session = ensureDirectChatSession(chat, workspaceId, rootPath, cwd)
  const store = useCodingStore.getState()
  // A brand-new chat has no transcript to hydrate, so show its first message
  // immediately while the agent session starts. Otherwise selecting the newly
  // created chat briefly renders the empty-chat composer before this message
  // arrives and makes the composer jump between layouts.
  const appendedOptimistically = !chat.sessionFile
  if (appendedOptimistically) store.appendUser(panelId, text)
  if (!(await session)) return false

  const controlUpdates: Promise<unknown>[] = []
  if (options.thinkingLevel) {
    store.setThinkingLevel(panelId, options.thinkingLevel)
    controlUpdates.push(window.electronAPI.agentSetThinkingLevel(panelId, options.thinkingLevel))
  }
  if (options.autoCompactionEnabled != null) {
    store.setAutoCompactionEnabled(panelId, options.autoCompactionEnabled)
    controlUpdates.push(window.electronAPI.agentSetAutoCompaction(panelId, options.autoCompactionEnabled))
  }

  try {
    await Promise.all(controlUpdates)
    if (options.promptMode) {
      await codingClient.prompt(
        panelId,
        options.promptModeCommand?.trim() || `/${options.promptMode}`,
      )
    }
    if (!appendedOptimistically) store.appendUser(panelId, text)
    await codingClient.prompt(panelId, text, options.images)
    return true
  } catch (error) {
    log.warn('[directChatSession] prompt failed for %s: %O', panelId, error)
    store.appendSystem(panelId, 'Send failed. Please try again.', 'error')
    return false
  }
}

export function persistDirectSessionFile(rootPath: string, chatId: string, file: string): void {
  const chat = useChatsStore.getState().getChat(rootPath, chatId)
  if (chat && chat.sessionFile !== file) {
    useChatsStore.getState().patchChat(rootPath, chatId, { sessionFile: file })
  }
}

export function disposeDirectChatSession(chatId: string, workspaceId: string): void {
  const panelId = directAgentKey(chatId)
  if (typeof window.electronAPI?.agentDispose === 'function') {
    void codingClient.dispose(panelId, { stopCodingAgents: true, workspaceId })
  }
  useCodingStore.getState().dispose(panelId)
}
