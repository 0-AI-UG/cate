// The core's entry, loaded by the app's hidden web view: boot the client,
// answer `window.cateCore.call`, push the state on every change, and name
// each joined workspace after its runtime's folder once it connects.

import type { MobileCoreMethod } from '../contract'
import { createCoreApi } from './api'
import { nameJoinedWorkspaces } from '@client/workspaces'
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

declare global {
  interface Window {
    cateCore?: { call(method: string, paramsJson: string): Promise<string> }
  }
}

async function start(): Promise<void> {
  const bridge = nativeBridge()
  const client = await bootMobileClient(bridge)
  const views = createMobileViews(client, bridge)
  const agents = createMobileAgents(client, bridge)
  const api = createCoreApi(client, {
    terminals: createMobileTerminals(client, bridge),
    views,
    browsers: createMobileBrowsers(views),
    chats: createMobileChats(views, bridge),
    buffers: createMobileBuffers(bridge),
    streams: createMobileStreams(client, bridge),
    agents,
  })
  window.cateCore = {
    async call(method, paramsJson) {
      const handler = api[method as MobileCoreMethod] as ((params: unknown) => Promise<unknown>) | undefined
      if (!handler) throw new Error(`unknown core method ${method}`)
      return JSON.stringify(await handler(JSON.parse(paramsJson)))
    },
  }
  const push = () => { void bridge('core.state', { json: JSON.stringify(snapshotOf(client, agents)) }) }
  watchState(client, agents, push)
  nameJoinedWorkspaces(client.workspaces, client.connections)
  push()
  await bridge('core.ready', {})
}

start().catch((error: unknown) => {
  console.error('Cate core failed to start', error)
  const message = error instanceof Error ? error.message : String(error)
  try { void nativeBridge()('core.failed', { message }) } catch { /* not in the app */ }
})
