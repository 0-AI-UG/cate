// =============================================================================
// IPC handlers for AUTH_* channels — thin wrappers around AuthManager.
// =============================================================================

import { ipcMain } from 'electron'
import {
  AUTH_LIST_PROVIDERS,
  AUTH_STATUS,
  AUTH_OAUTH_START,
  AUTH_OAUTH_PROMPT_REPLY,
  AUTH_SAVE_API_KEY,
  AUTH_DELETE,
  AUTH_LIST_MODELS,
} from '../../shared/ipc-channels'
import log from '../../main/logger'
import type { AuthManager } from './authManager'

export function registerAuthHandlers(authManager: AuthManager): void {
  ipcMain.handle(AUTH_LIST_PROVIDERS, async () => {
    return authManager.listProviders()
  })

  ipcMain.handle(AUTH_STATUS, async () => {
    return authManager.status()
  })

  ipcMain.handle(AUTH_OAUTH_START, async (event, providerId: string) => {
    try {
      await authManager.startOAuth(providerId, event.sender)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('[ipc.auth] oauth start failed for %s: %s', providerId, message)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(
    AUTH_OAUTH_PROMPT_REPLY,
    async (_event, promptId: string, value: string | null) => {
      authManager.handlePromptReply(promptId, value)
    },
  )

  ipcMain.handle(AUTH_SAVE_API_KEY, async (_event, providerId: string, apiKey: string) => {
    await authManager.saveApiKey(providerId, apiKey)
  })

  ipcMain.handle(AUTH_DELETE, async (_event, providerId: string) => {
    await authManager.deleteProvider(providerId)
  })

  ipcMain.handle(AUTH_LIST_MODELS, async () => {
    return authManager.listModels()
  })
}
