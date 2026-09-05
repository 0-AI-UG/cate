import log from '../logger'
import { getSetting } from '../settingsFile'
import { CateApiEndpointManager, cateApiEndpointManager } from './cateApiEndpointManager'
import { codingAgentAdmission } from './codingAgentAdmission'

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
        key: workspaceId,
        workspaceId,
        listenerId: `cateapi-terminal-${workspaceId}`,
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
    this.endpoints.dispose(workspaceId)
    codingAgentAdmission.clearWorkspace(workspaceId)
  }

  disposeForRuntime(runtimeId: string): void {
    this.endpoints.disposeForRuntime(runtimeId)
  }

  disposeAll(): void {
    this.endpoints.disposeAll()
    codingAgentAdmission.clearAll()
  }
}

export const workspaceCateApi = new WorkspaceCateApiManager(cateApiEndpointManager)
