import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  AGENT_HARNESS_GET_PANEL_URL,
  AGENT_HARNESS_LIST_CONVERSATIONS,
  AGENT_HARNESS_DELETE_CONVERSATION,
  AGENT_CONVERSATION_DELETED,
  AGENT_HARNESS_GET_STATUS,
  AGENT_HARNESS_PANEL_CLOSED,
  AGENT_HARNESS_RESTART,
  AGENT_PROVIDER_AUTH_START,
  AGENT_PROVIDER_AUTH_GET,
  AGENT_PROVIDER_AUTH_WRITE,
  AGENT_PROVIDER_AUTH_CANCEL,
  AGENT_PROVIDER_STATUS_GET,
  AGENT_PROVIDER_SETTINGS,
} from '../../shared/ipc-channels'
import type { AgentHarnessPanelRequest, AgentProviderAuthRequest, AgentProviderId, AgentProviderStatusRequest } from '../../shared/t3Agent'
import { t3HarnessManager } from '../t3Agent/T3HarnessManager'
import { broadcastToAll, windowFromEvent } from '../windowRegistry'

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`)
  }
  return value
}

function validateRequest(value: unknown): AgentHarnessPanelRequest {
  if (!value || typeof value !== 'object') throw new Error('Agent harness request is required')
  const input = value as Record<string, unknown>
  const route = input.route
  if (route !== undefined && route !== 'thread' && route !== 'providers') {
    throw new Error('route must be thread or providers')
  }
  return {
    workspaceId: requireText(input.workspaceId, 'workspaceId'),
    panelId: requireText(input.panelId, 'panelId'),
    cwd: requireText(input.cwd, 'cwd'),
    ...(typeof input.threadId === 'string' && input.threadId.length > 0 ? { threadId: input.threadId } : {}),
    ...(route ? { route } : {}),
  }
}

const PROVIDER_IDS = new Set<AgentProviderId>(['codex', 'claude', 'cursor', 'grok', 'opencode'])

function validateProviderAuthRequest(value: unknown): AgentProviderAuthRequest {
  if (!value || typeof value !== 'object') throw new Error('Provider sign-in request is required')
  const input = value as Record<string, unknown>
  if (typeof input.providerId !== 'string' || !PROVIDER_IDS.has(input.providerId as AgentProviderId)) {
    throw new Error('Unknown agent provider')
  }
  return {
    workspaceId: requireText(input.workspaceId, 'workspaceId'),
    cwd: requireText(input.cwd, 'cwd'),
    providerId: input.providerId as AgentProviderId,
    ...(typeof input.provider === 'string' && input.provider.trim()
      ? { provider: input.provider.trim() }
      : {}),
  }
}

function validateProviderStatusRequest(value: unknown): AgentProviderStatusRequest {
  if (!value || typeof value !== 'object') throw new Error('Provider status request is required')
  const input = value as Record<string, unknown>
  return {
    workspaceId: requireText(input.workspaceId, 'workspaceId'),
    cwd: requireText(input.cwd, 'cwd'),
  }
}

function requireWindowId(event: IpcMainInvokeEvent): number {
  const windowId = windowFromEvent(event)?.id
  if (windowId === undefined) throw new Error('Provider sign-in window is unavailable')
  return windowId
}

export function registerT3AgentHandlers(): void {
  ipcMain.handle(AGENT_HARNESS_DELETE_CONVERSATION, async (event, input: unknown) => {
    try {
      const request = validateProviderStatusRequest(input)
      const threadId = requireText((input as { threadId?: unknown }).threadId, 'threadId')
      const partition = await t3HarnessManager.deleteConversation({ ...request, threadId }, requireWindowId(event))
      broadcastToAll(AGENT_CONVERSATION_DELETED, { workspaceId: request.workspaceId, partition, threadId })
      return { ok: true }
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(AGENT_HARNESS_LIST_CONVERSATIONS, async (event, input: unknown) => {
    try {
      return await t3HarnessManager.listConversations(validateProviderStatusRequest(input), requireWindowId(event))
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(AGENT_PROVIDER_SETTINGS, async (event, input: any) => {
    try {
      const base = validateProviderStatusRequest(input)
      if (!['read', 'save', 'refresh', 'update'].includes(input.operation)) throw new Error('Invalid provider operation')
      return await t3HarnessManager.providerSettingsOperation({ ...base, operation: input.operation,
        patch: input.patch, provider: input.provider, instanceId: input.instanceId }, requireWindowId(event))
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(AGENT_HARNESS_GET_PANEL_URL, async (event, input: unknown) => {
    try {
      return await t3HarnessManager.getPanelTarget(validateRequest(input), event.sender.id)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.on(AGENT_HARNESS_PANEL_CLOSED, (_event, input: unknown) => {
    if (!input || typeof input !== 'object') return
    const panelId = (input as { panelId?: unknown }).panelId
    if (typeof panelId === 'string') t3HarnessManager.panelClosed(panelId)
  })

  ipcMain.handle(AGENT_HARNESS_RESTART, async (_event, input: unknown) => {
    try {
      if (!input || typeof input !== 'object') throw new Error('Agent harness restart request is required')
      await t3HarnessManager.restart(requireText((input as { cwd?: unknown }).cwd, 'cwd'))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(AGENT_HARNESS_GET_STATUS, (_event, input: unknown) => {
    if (!input || typeof input !== 'object') return { phase: 'stopped' as const }
    const cwd = (input as { cwd?: unknown }).cwd
    return typeof cwd === 'string' ? t3HarnessManager.getStatus(cwd) : { phase: 'stopped' as const }
  })

  ipcMain.handle(AGENT_PROVIDER_AUTH_START, async (event, input: unknown) => {
    try {
      return await t3HarnessManager.startProviderAuth(validateProviderAuthRequest(input), requireWindowId(event))
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(AGENT_PROVIDER_AUTH_GET, (event, input: unknown) => {
    try {
      if (!input || typeof input !== 'object') throw new Error('Provider sign-in session is required')
      return t3HarnessManager.getProviderAuth(
        requireText((input as { id?: unknown }).id, 'id'),
        requireWindowId(event),
      )
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(AGENT_PROVIDER_AUTH_WRITE, (event, input: unknown) => {
    try {
      if (!input || typeof input !== 'object') throw new Error('Provider sign-in input is required')
      const request = input as { id?: unknown; data?: unknown }
      t3HarnessManager.writeProviderAuth(
        requireText(request.id, 'id'),
        requireWindowId(event),
        typeof request.data === 'string' ? request.data : '',
      )
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(AGENT_PROVIDER_AUTH_CANCEL, (event, input: unknown) => {
    try {
      if (!input || typeof input !== 'object') throw new Error('Provider sign-in session is required')
      t3HarnessManager.cancelProviderAuth(
        requireText((input as { id?: unknown }).id, 'id'),
        requireWindowId(event),
      )
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(AGENT_PROVIDER_STATUS_GET, async (event, input: unknown) => {
    try {
      return await t3HarnessManager.getProviderStatuses(
        validateProviderStatusRequest(input),
        requireWindowId(event),
      )
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
}
