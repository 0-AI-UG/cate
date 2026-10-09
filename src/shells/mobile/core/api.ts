// The core API the app calls (`MobileCoreMethods`).

import { runtimeFor } from '@kernel/rpc/client'
import { ensureOpenedTrusted, joinErrorMessage, joinWorkspace, trustStore } from '@client/workspaces'
import { closePanel, createPanel, creatableDefinitions } from '@client/host'
import { documentStoreFor } from '@client/document'
import { surfaceChoices, surfaceReplacement } from '@panels/definitions'
import type { AnyPanelDefinition } from '@panels/framework/contract'
import { isPanelType } from '@workspace/document/contract'
import type { MobileCoreMethod, MobileCoreMethods, MobilePanelChoice } from '../contract'
import type { MobileClient } from './boot'
import { createActionHandlers } from './actions'
import type { MobileAgents } from './agents'
import type { MobileBrowsers } from './browser'
import type { MobileBuffers } from './buffers'
import type { MobileChats } from './chat'
import type { MobileConversations } from './conversations'
import { placementOptions } from './placement'
import { loopbackPort, type MobileStreams } from './streams'
import type { MobileTerminals } from './terminals'
import type { MobileViews } from './views'

type Handlers = { [M in MobileCoreMethod]: (params: MobileCoreMethods[M]['params']) => Promise<MobileCoreMethods[M]['result']> }

export interface CoreParts {
  terminals: MobileTerminals
  views: MobileViews
  browsers: MobileBrowsers
  chats: MobileChats
  buffers: MobileBuffers
  streams: MobileStreams
  agents: MobileAgents
  conversations: MobileConversations
}

const choice = (definition: AnyPanelDefinition): MobilePanelChoice => ({
  type: definition.type,
  label: definition.label,
  icon: definition.icon,
  canvas: definition.canLiveOnCanvas,
})

export function createCoreApi(client: MobileClient, parts: CoreParts): Handlers {
  const { workspaces, connections } = client
  /** Asks for trust once the runtime answers; a declined workspace closes. */
  const keepIfTrusted = async (workspaceId: string) => {
    if ((await ensureOpenedTrusted({ workspaces, connections }, workspaceId)) === 'declined') workspaces.close(workspaceId)
  }
  const { terminals, views, browsers, chats, buffers, streams, agents, conversations } = parts
  return {
    ...createActionHandlers(agents, conversations),
    async 'workspaces.join'({ input }) {
      try {
        const entry = await joinWorkspace(input, { pair: client.pair, workspaces })
        await workspaces.open(entry.id)
        void keepIfTrusted(entry.id)
        return { ok: true, workspaceId: entry.id }
      } catch (error) {
        return { ok: false, message: joinErrorMessage(error) }
      }
    },
    async 'workspaces.open'({ workspaceId }) {
      const wasOpen = workspaces.getSnapshot().open.includes(workspaceId)
      await workspaces.open(workspaceId)
      if (!wasOpen) void keepIfTrusted(workspaceId)
      return null
    },
    async 'workspaces.answerTrust'({ trusted }) {
      try {
        await trustStore.answer(trusted)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Could not trust the workspace.' }
      }
    },
    async 'workspaces.close'({ workspaceId }) {
      workspaces.close(workspaceId)
      return null
    },
    async 'workspaces.stop'({ workspaceId }) {
      try {
        await runtimeFor(workspaceId).runtime.stop()
      } finally {
        workspaces.close(workspaceId)
      }
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

    async 'panel.open'(params) {
      views.open(params)
      return null
    },
    'panel.op': ({ viewId, op }) => views.op(viewId, op),
    async 'panel.close'({ viewId }) {
      views.get(viewId)?.close()
      return null
    },
    async 'panel.creatable'() {
      return creatableDefinitions().map(choice)
    },
    async 'panel.create'({ workspaceId, type, placement }) {
      return isPanelType(type) ? createPanel(workspaceId, type, { ...placementOptions(type, placement) }) : null
    },
    'panel.remove': ({ workspaceId, panelId }) => closePanel(workspaceId, panelId),
    async 'surface.choices'({ workspaceId, panelId }) {
      const doc = documentStoreFor(workspaceId)?.getSnapshot()
      return doc ? surfaceChoices(doc, panelId).map(choice) : []
    },
    async 'surface.pick'({ workspaceId, panelId, type }) {
      const store = documentStoreFor(workspaceId)
      const record = store && isPanelType(type) ? surfaceReplacement(store.getSnapshot(), panelId, type) : null
      return !!record && store!.propose({ kind: 'replacePanel', record }).ok
    },

    async 'buffer.open'(params) {
      buffers.open(params)
      return null
    },
    async 'buffer.edit'({ viewId, from, length, text }) {
      const buffer = buffers.get(viewId)
      if (!buffer) throw new Error('The file is not open.')
      return { text: buffer.edit(from, length, text) }
    },
    async 'buffer.close'({ viewId }) {
      buffers.get(viewId)?.close()
      return null
    },
    async 'files.list'({ workspaceId, path }) {
      const entries = await runtimeFor(workspaceId).file.readDir({ path })
      return entries
        .map(({ name, path, isDirectory }) => ({ name, path, isDirectory }))
        .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
    },
    async 'files.url'({ workspaceId, path }) {
      return (await runtimeFor(workspaceId).file.serveUrl({ path })).url
    },

    async 'browser.open'(params) {
      browsers.open(params)
      return null
    },
    async 'browser.navigated'(params) {
      browsers.navigated(params)
      return null
    },
    async 'browser.loading'(params) {
      browsers.loading(params)
      return null
    },
    async 'browser.title'(params) {
      browsers.title(params)
      return null
    },

    async 'chat.open'(params) {
      chats.open(params)
      return null
    },
    'chat.page': async (params) => chats.page(params),
    'chat.navigation': async (params) => chats.navigation(params),
    'chat.hostMessage': (params) => chats.hostMessage(params),
    'chat.conversations': (params) => chats.conversations(params),

    async 'loopback.port'({ url }) {
      return loopbackPort(url)
    },
    async 'stream.open'(params) {
      await streams.open(params)
      return null
    },
    async 'stream.write'({ streamId, data }) {
      streams.get(streamId)?.write(data)
      return null
    },
    async 'stream.close'({ streamId }) {
      streams.get(streamId)?.close()
      return null
    },
  }
}
