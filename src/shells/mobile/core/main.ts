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
import { createMobileBuffers } from './buffers'
import { createMobileStreams } from './streams'
import { createMobileAgents } from './agents'
import { createMobileConversations } from './conversations'
import { createMobileRelations } from './relations'
import { installClientUi } from '@kernel/interaction'
import { createMobileClientUi } from './clientUi'
import { createMobileLinks } from './links'
import { noteClientActivity } from '@client/document'

declare global {
  interface Window {
    cateCore?: { call(method: string, paramsJson: string): Promise<string> }
  }
}

async function start(): Promise<void> {
  const bridge = nativeBridge()
  const links = createMobileLinks()
  installClientUi(createMobileClientUi(bridge, links))
  const client = await bootMobileClient(bridge)
  const views = createMobileViews(bridge)
  const agents = createMobileAgents(client, bridge)
  const relations = createMobileRelations(client)
  const api = createCoreApi(client, {
    terminals: createMobileTerminals(client, bridge),
    views,
    browsers: createMobileBrowsers(views),
    buffers: createMobileBuffers(bridge),
    streams: createMobileStreams(client, bridge),
    agents,
    conversations: createMobileConversations(bridge),
    links,
  })
  window.cateCore = {
    async call(method, paramsJson) {
      const handler = api[method as MobileCoreMethod] as ((params: unknown) => Promise<unknown>) | undefined
      if (!handler) throw new Error(`unknown core method ${method}`)
      // The app calls the core as the person uses it: the client is in use.
      if (method !== 'app.setActive') noteClientActivity()
      return JSON.stringify(await handler(JSON.parse(paramsJson)))
    },
  }
  // A change that leaves the state as it was is not pushed.
  let pushed = ''
  const push = () => {
    const json = JSON.stringify(snapshotOf(client, agents, relations, links))
    if (json === pushed) return
    pushed = json
    void bridge('core.state', { json })
  }
  watchState(client, agents, relations, links, push)
  push()
  await bridge('core.ready', {})
}

start().catch((error: unknown) => {
  console.error('Cate core failed to start', error)
  const message = error instanceof Error ? error.message : String(error)
  try { void nativeBridge()('core.failed', { message }) } catch { /* not in the app */ }
})
