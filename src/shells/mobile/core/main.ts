// The core's entry, loaded by the app's hidden web view: boot the client,
// answer `window.cateCore.call`, push the state on every change, and name
// each joined workspace after its runtime's folder once it connects.

import type { MobileCoreMethod } from '../contract'
import { createCoreApi } from './api'
import { bootMobileClient } from './boot'
import { nativeBridge } from './bridge'
import { snapshotOf, watchState } from './state'
import { createMobileTerminals } from './terminals'
import { createMobileViews } from './views'
import { createMobileBrowsers } from './browser'
import { createMobileChats } from './chat'
import { createMobileBuffers } from './buffers'
import { createMobileStreams } from './streams'
import { createMobileAgents } from './agents'
import { createMobileConversations } from './conversations'
import { createMobileRelations } from './relations'
import { installClientUi } from '@kernel/interaction'
import { createMobileClientUi } from './clientUi'

declare global {
  interface Window {
    cateCore?: { call(method: string, paramsJson: string): Promise<string> }
  }
}

async function start(): Promise<void> {
  const bridge = nativeBridge()
  installClientUi(createMobileClientUi(bridge))
  const client = await bootMobileClient(bridge)
  const views = createMobileViews(bridge)
  const agents = createMobileAgents(client, bridge)
  const relations = createMobileRelations(client)
  const api = createCoreApi(client, {
    terminals: createMobileTerminals(client, bridge),
    views,
    browsers: createMobileBrowsers(views),
    chats: createMobileChats(views),
    buffers: createMobileBuffers(bridge),
    streams: createMobileStreams(client, bridge),
    agents,
    conversations: createMobileConversations(bridge),
  })
  window.cateCore = {
    async call(method, paramsJson) {
      const handler = api[method as MobileCoreMethod] as ((params: unknown) => Promise<unknown>) | undefined
      if (!handler) throw new Error(`unknown core method ${method}`)
      return JSON.stringify(await handler(JSON.parse(paramsJson)))
    },
  }
  // A change that leaves the state as it was is not pushed.
  let pushed = ''
  const push = () => {
    const json = JSON.stringify(snapshotOf(client, agents, relations))
    if (json === pushed) return
    pushed = json
    void bridge('core.state', { json })
  }
  watchState(client, agents, relations, push)
  push()
  await bridge('core.ready', {})
}

start().catch((error: unknown) => {
  console.error('Cate core failed to start', error)
  const message = error instanceof Error ? error.message : String(error)
  try { void nativeBridge()('core.failed', { message }) } catch { /* not in the app */ }
})
