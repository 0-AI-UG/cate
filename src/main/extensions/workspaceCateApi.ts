// First-party CATE_API access for terminals and agents. Reverse-endpoint
// lifecycle is owned by cateApiEndpointManager alongside extension endpoints;
// this class contributes only the user setting gate and first-party scopes.

import log from '../logger'
import { getSetting } from '../settingsFile'
import { CateApiEndpointManager, cateApiEndpointManager } from './cateApiEndpointManager'
import { codingAgentAdmission } from './codingAgentAdmission'
import type { WebContents } from 'electron'

const FIRST_PARTY_ID = 'terminal'
const endpointKey = (workspaceId: string): string => `first-party:${workspaceId}`
const cateAgentEndpointKey = (workspaceId: string, panelId: string): string =>
  `cate-agent:${workspaceId}:${panelId}`

// Only scopes the CLI has verbs for. workspace.read/theme exist for extensions
// (webviews with no filesystem) — a terminal's cwd IS the workspace root, so
// granting them here would be dead surface.
export const GRANTED_SCOPES: readonly string[] = [
  'browser',
  'ui',
  'editor',
  'canvas',
  'panel',
  'terminal',
]

export const CATE_AGENT_GRANTED_SCOPES: readonly string[] = [
  ...GRANTED_SCOPES,
  'coding-agent',
]

export interface WorkspaceCateApiEndpoint {
  port: number
  token: string
}

export class WorkspaceCateApiManager {
  private readonly cateAgentKeys = new Map<string, Set<string>>()

  constructor(private readonly endpoints = new CateApiEndpointManager()) {}

  async ensureEndpoint(workspaceId: string): Promise<WorkspaceCateApiEndpoint | null> {
    if (getSetting('cliEnabled') !== true) return null
    try {
      const endpoint = await this.endpoints.ensure({
        key: endpointKey(workspaceId),
        owner: 'first-party',
        extensionId: FIRST_PARTY_ID,
        workspaceId,
        listenerId: `cateapi-terminal-${workspaceId}`,
        caller: 'first-party',
        grantedScopes: [...GRANTED_SCOPES],
      })
      log.info('[workspace-cateapi] endpoint up ws=%s port=%d', workspaceId, endpoint.port)
      return { port: endpoint.port, token: endpoint.token }
    } catch (err) {
      log.warn('[workspace-cateapi] failed to open listener for %s: %O', workspaceId, err)
      return null
    }
  }

  /** A token minted only for the embedded Cate Agent. Unlike the token injected
   *  into ordinary terminals, it may create and supervise coding agents. The
   *  endpoint is bound to the originating agent panel/session for worktree
   *  affinity and cannot be obtained by a spawned worker. */
  async ensureCateAgentEndpoint(
    workspaceId: string,
    panelId: string,
    originCwd: string,
    ownerWebContents?: WebContents,
  ): Promise<WorkspaceCateApiEndpoint | null> {
    try {
      const endpoint = await this.endpoints.ensure({
        key: cateAgentEndpointKey(workspaceId, panelId),
        owner: 'cate-agent',
        extensionId: 'cate-agent',
        workspaceId,
        panelId,
        originCwd,
        listenerId: `cateapi-agent-${workspaceId}-${panelId}`,
        caller: 'cate-agent',
        grantedScopes: [...CATE_AGENT_GRANTED_SCOPES],
        ownerWebContents,
      })
      const keys = this.cateAgentKeys.get(workspaceId) ?? new Set<string>()
      keys.add(cateAgentEndpointKey(workspaceId, panelId))
      this.cateAgentKeys.set(workspaceId, keys)
      log.info('[workspace-cateapi] Cate Agent endpoint up ws=%s panel=%s port=%d', workspaceId, panelId, endpoint.port)
      return { port: endpoint.port, token: endpoint.token }
    } catch (err) {
      log.warn('[workspace-cateapi] failed to open Cate Agent listener for %s: %O', workspaceId, err)
      return null
    }
  }

  disposeCateAgentEndpoint(workspaceId: string, panelId: string): void {
    const key = cateAgentEndpointKey(workspaceId, panelId)
    this.endpoints.dispose(key)
    const keys = this.cateAgentKeys.get(workspaceId)
    keys?.delete(key)
    if (keys?.size === 0) this.cateAgentKeys.delete(workspaceId)
    codingAgentAdmission.clearMission(workspaceId, panelId)
  }

  /** Tear down a single workspace's first-party endpoint. The local runtime never
   *  disconnects during app life, so without this every opened-then-closed
   *  workspace would leak its loopback listener + http.Server for the session. */
  disposeForWorkspace(workspaceId: string): void {
    this.endpoints.dispose(endpointKey(workspaceId))
    for (const key of this.cateAgentKeys.get(workspaceId) ?? []) {
      this.endpoints.dispose(key)
    }
    this.cateAgentKeys.delete(workspaceId)
    codingAgentAdmission.clearWorkspace(workspaceId)
  }

  disposeForRuntime(runtimeId: string): void {
    this.endpoints.disposeForRuntime('first-party', runtimeId)
    this.endpoints.disposeForRuntime('cate-agent', runtimeId)
  }

  disposeAll(): void {
    this.endpoints.disposeAll('first-party')
    this.endpoints.disposeAll('cate-agent')
    this.cateAgentKeys.clear()
    codingAgentAdmission.clearAll()
  }
}

export const workspaceCateApi = new WorkspaceCateApiManager(cateApiEndpointManager)
