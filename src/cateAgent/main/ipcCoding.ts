// =============================================================================
// IPC handlers for AGENT_* channels — thin wrappers around CodingManager.
// =============================================================================

import { ipcMain } from 'electron'
import {
  CODING_CREATE,
  CODING_PROMPT,
  CODING_INTERRUPT,
  CODING_DISPOSE,
  CODING_SET_MODEL,
  CODING_GET_COMMANDS,
  CODING_STEER,
  CODING_SET_THINKING_LEVEL,
  CODING_COMPACT,
  CODING_SET_AUTO_COMPACTION,
  CODING_ABORT_RETRY,
  CODING_GET_SESSION_STATS,
  CODING_GET_STATE,
  CODING_FORK,
  CODING_GET_FORK_MESSAGES,
  CODING_LIST_MODELS,
  CODING_UI_RESPONSE,
  CODING_LIST_SESSIONS,
  CODING_LOAD_SESSION_MESSAGES,
  CODING_DELETE_SESSION,
  CODING_CUSTOM_MODELS_GET,
  CODING_CUSTOM_MODELS_SAVE,
  CODING_CUSTOM_MODELS_DELETE,
} from '../../shared/ipc-channels'
import { deleteSession, listSessions, loadSessionTranscript } from './sessionFiles'
import {
  deleteCustomOpenAIProvider,
  readCustomOpenAIProviders,
  saveCustomOpenAIProvider,
} from './customModels'
import log from '../../main/logger'
import { sendEvent } from '../../main/analytics'
import type {
  CodingCreateOptions,
  CodingExtensionUIResponse,
  CodingImageAttachment,
  CateAgentModelRef,
  CodingThinkingLevel,
  CustomOpenAIProvider,
} from '../../shared/types'
import type { AuthManager } from './authManager'
import type { CodingManager } from './codingManager'

// Anonymous telemetry for user-sent agent messages. We record only the kind of
// message, its length, and whether it carried images — never the message text.
function trackMessageSent(kind: 'prompt' | 'steer' | 'follow_up', text: string, images?: unknown[]): void {
  void sendEvent('agent_message_sent', {
    kind,
    chars: typeof text === 'string' ? text.length : 0,
    has_images: Array.isArray(images) && images.length > 0,
  })
}

export function registerCodingHandlers(authManager: AuthManager, codingManager: CodingManager): void {
  // webContents we've already hooked 'destroyed' on, so a window hosting many
  // agent chats registers a single listener (which tears down all of its
  // sessions) rather than one per CODING_CREATE.
  const hookedSenders = new Set<number>()

  ipcMain.handle(CODING_CREATE, async (event, options: CodingCreateOptions) => {
    try {
      // Tie pi lifetime to the owning window: when its webContents is destroyed
      // (window closed) drop every session it owns, so leaked chats don't
      // survive until app quit.
      const sender = event.sender
      if (!hookedSenders.has(sender.id)) {
        hookedSenders.add(sender.id)
        const wcId = sender.id
        sender.once('destroyed', () => {
          hookedSenders.delete(wcId)
          codingManager.disposeForWebContents(wcId)
        })
      }
      await codingManager.create(options, sender)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('[ipc.agent] create failed: %s', message)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(
    CODING_PROMPT,
    async (_event, panelId: string, text: string, images?: CodingImageAttachment[]) => {
      trackMessageSent('prompt', text, images)
      await codingManager.prompt(panelId, text, images)
    },
  )

  ipcMain.handle(
    CODING_STEER,
    async (_event, panelId: string, text: string, images?: CodingImageAttachment[]) => {
      trackMessageSent('steer', text, images)
      await codingManager.steer(panelId, text, images)
    },
  )

  ipcMain.handle(
    CODING_SET_THINKING_LEVEL,
    async (_event, panelId: string, level: CodingThinkingLevel) => {
      await codingManager.setThinkingLevel(panelId, level)
    },
  )

  ipcMain.handle(
    CODING_COMPACT,
    async (_event, panelId: string, customInstructions?: string) => {
      return codingManager.compact(panelId, customInstructions)
    },
  )

  ipcMain.handle(
    CODING_SET_AUTO_COMPACTION,
    async (_event, panelId: string, enabled: boolean) => {
      await codingManager.setAutoCompaction(panelId, enabled)
    },
  )

  ipcMain.handle(CODING_ABORT_RETRY, async (_event, panelId: string) => {
    await codingManager.abortRetry(panelId)
  })

  ipcMain.handle(CODING_GET_SESSION_STATS, async (_event, panelId: string) => {
    try {
      return await codingManager.getSessionStats(panelId)
    } catch (err) {
      log.warn('[ipc.agent] getSessionStats failed: %O', err)
      return null
    }
  })

  ipcMain.handle(CODING_GET_STATE, async (_event, panelId: string) => {
    try {
      return await codingManager.getState(panelId)
    } catch (err) {
      log.warn('[ipc.agent] getState failed: %O', err)
      return null
    }
  })

  ipcMain.handle(CODING_FORK, async (_event, panelId: string, entryId: string) => {
    return codingManager.fork(panelId, entryId)
  })

  ipcMain.handle(CODING_GET_FORK_MESSAGES, async (_event, panelId: string) => {
    try {
      return await codingManager.getForkMessages(panelId)
    } catch (err) {
      log.warn('[ipc.agent] getForkMessages failed: %O', err)
      return []
    }
  })

  ipcMain.handle(CODING_LIST_MODELS, async () => {
    try {
      return await authManager.listAvailableModels()
    } catch (err) {
      log.warn('[ipc.agent] listModels failed: %O', err)
      return []
    }
  })

  // Extension UI sub-protocol: fire-and-forget from renderer; main writes the
  // response back to pi's stdin so the awaiting extension dialog resolves.
  ipcMain.on(CODING_UI_RESPONSE, (_event, panelId: string, response: CodingExtensionUIResponse) => {
    codingManager.uiResponse(panelId, response)
  })

  // Disk-backed pi session index — read straight from the workspace's
  // .cate/cate-agent/sessions/ dir.
  ipcMain.handle(CODING_LIST_SESSIONS, async (_event, cwd: string) => {
    if (!cwd) return []
    return listSessions(cwd)
  })

  ipcMain.handle(CODING_LOAD_SESSION_MESSAGES, async (_event, sessionFile: string) => {
    if (!sessionFile) return []
    return loadSessionTranscript(sessionFile)
  })

  ipcMain.handle(CODING_DELETE_SESSION, async (_event, sessionFile: string) => {
    if (!sessionFile) return
    await deleteSession(sessionFile)
  })

  ipcMain.handle(CODING_INTERRUPT, async (_event, panelId: string) => {
    await codingManager.interrupt(panelId)
  })

  ipcMain.handle(CODING_DISPOSE, async (
    event,
    panelId: string,
    options?: { stopCodingAgents?: boolean; workspaceId?: string },
  ) => {
    await codingManager.dispose(panelId, options, event.sender)
  })

  ipcMain.handle(CODING_SET_MODEL, async (_event, panelId: string, model: CateAgentModelRef) => {
    await codingManager.setModel(panelId, model)
  })

  ipcMain.handle(CODING_GET_COMMANDS, async (_event, panelId: string) => {
    try {
      return await codingManager.getCommands(panelId)
    } catch (err) {
      log.warn('[ipc.agent] getCommands failed: %O', err)
      return []
    }
  })

  // ---------------------------------------------------------------------------
  // Custom OpenAI-compatible provider (pi models.json)
  // ---------------------------------------------------------------------------

  ipcMain.handle(CODING_CUSTOM_MODELS_GET, async () => {
    try {
      return await readCustomOpenAIProviders()
    } catch (err) {
      log.warn('[ipc.agent] customModelsGet failed: %O', err)
      return []
    }
  })

  ipcMain.handle(CODING_CUSTOM_MODELS_SAVE, async (_event, cfg: CustomOpenAIProvider) => {
    await saveCustomOpenAIProvider(cfg)
    await codingManager.syncCustomModelsToOpenSessions()
  })

  ipcMain.handle(CODING_CUSTOM_MODELS_DELETE, async (_event, providerId: string) => {
    await deleteCustomOpenAIProvider(providerId)
    await codingManager.syncCustomModelsToOpenSessions()
  })
}
