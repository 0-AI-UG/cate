// The core API the app calls (`MobileCoreMethods`).

import { joinErrorMessage, joinWorkspace } from '@client/workspaces'
import type { MobileCoreMethod, MobileCoreMethods } from '../contract'
import type { MobileClient } from './boot'
import type { MobileTerminals } from './terminals'

type Handlers = { [M in MobileCoreMethod]: (params: MobileCoreMethods[M]['params']) => Promise<MobileCoreMethods[M]['result']> }

export function createCoreApi(client: MobileClient, terminals: MobileTerminals): Handlers {
  const { workspaces, connections } = client
  return {
    async 'workspaces.join'({ input }) {
      try {
        const entry = await joinWorkspace(input, { pair: client.pair, workspaces })
        await workspaces.open(entry.id)
        return { ok: true, workspaceId: entry.id }
      } catch (error) {
        return { ok: false, message: joinErrorMessage(error) }
      }
    },
    async 'workspaces.open'({ workspaceId }) {
      await workspaces.open(workspaceId)
      return null
    },
    async 'workspaces.close'({ workspaceId }) {
      workspaces.close(workspaceId)
      return null
    },
    async 'workspaces.retry'({ workspaceId }) {
      connections.get(workspaceId)?.retryNow()
      return null
    },
    async 'workspaces.forget'({ workspaceId }) {
      await workspaces.forget(workspaceId)
      return null
    },
    async 'terminal.open'(params) {
      terminals.open(params)
      return null
    },
    async 'terminal.input'({ terminalId, data }) {
      terminals.get(terminalId)?.input(data)
      return null
    },
    async 'terminal.resize'({ terminalId, cols, rows }) {
      terminals.get(terminalId)?.resize(cols, rows)
      return null
    },
    async 'terminal.fit'({ terminalId }) {
      terminals.get(terminalId)?.fit()
      return null
    },
    async 'terminal.close'({ terminalId }) {
      terminals.get(terminalId)?.close()
      return null
    },
  }
}
