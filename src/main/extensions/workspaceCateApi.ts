// First-party CATE_API access for terminals and agents. Reverse-endpoint
// lifecycle is owned by cateApiEndpointManager alongside extension endpoints;
// this class contributes only the user setting gate and first-party scopes.

import log from '../logger'
import { getSetting } from '../settingsFile'
import { CateApiEndpointManager, cateApiEndpointManager } from './cateApiEndpointManager'

const FIRST_PARTY_ID = 'terminal'
const endpointKey = (workspaceId: string): string => `first-party:${workspaceId}`

// Only scopes the CLI has verbs for. workspace.read/theme exist for extensions
// (webviews with no filesystem) — a terminal's cwd IS the workspace root, so
// granting them here would be dead surface.
export const GRANTED_SCOPES: readonly string[] = [
  'browser',
  'ui',
  'editor',
  'canvas',
  'panel',
]

export interface WorkspaceCateApiEndpoint {
  port: number
  token: string
}

export class WorkspaceCateApiManager {
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

  /** Tear down a single workspace's first-party endpoint. The local runtime never
   *  disconnects during app life, so without this every opened-then-closed
   *  workspace would leak its loopback listener + http.Server for the session. */
  disposeForWorkspace(workspaceId: string): void {
    this.endpoints.dispose(endpointKey(workspaceId))
  }

  disposeForRuntime(runtimeId: string): void {
    this.endpoints.disposeForRuntime('first-party', runtimeId)
  }

  disposeAll(): void {
    this.endpoints.disposeAll('first-party')
  }
}

export const workspaceCateApi = new WorkspaceCateApiManager(cateApiEndpointManager)
