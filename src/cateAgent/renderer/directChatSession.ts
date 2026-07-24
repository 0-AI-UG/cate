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

export interface DirectChatTurnOptions {
  images?: CodingImageAttachment[]
  thinkingLevel?: CodingThinkingLevel
  autoCompactionEnabled?: boolean
  promptMode?: ComposerPromptMode
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
  if (useCodingStore.getState().panels[panelId]) return true
  const inFlight = creating.get(panelId)
  if (inFlight) return inFlight

  const promise = (async () => {
    const store = useCodingStore.getState()
    store.init(panelId)
    const model = (await resolveSessionModel(chat.model)) ?? undefined
    if (model) store.setModel(panelId, model)
    if (chat.sessionFile) {
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
        store.appendSystem(panelId, `Failed to start agent: ${result.error}`, 'error')
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
  if (!(await ensureDirectChatSession(chat, workspaceId, rootPath, cwd))) return false

  const store = useCodingStore.getState()
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
    if (options.promptMode) await codingClient.prompt(panelId, `/${options.promptMode}`)
    store.appendUser(panelId, text)
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

export function disposeDirectChatSession(chatId: string): void {
  const panelId = directAgentKey(chatId)
  if (typeof window.electronAPI?.agentDispose === 'function') {
    void codingClient.dispose(panelId)
  }
  useCodingStore.getState().dispose(panelId)
}
