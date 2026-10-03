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

declare global {
  interface Window {
    cateCore?: { call(method: string, paramsJson: string): Promise<string> }
  }
}

async function start(): Promise<void> {
  const bridge = nativeBridge()
  const client = await bootMobileClient(bridge)
  const api = createCoreApi(client, createMobileTerminals(client, bridge))
  window.cateCore = {
    async call(method, paramsJson) {
      const handler = api[method as MobileCoreMethod] as ((params: unknown) => Promise<unknown>) | undefined
      if (!handler) throw new Error(`unknown core method ${method}`)
      return JSON.stringify(await handler(JSON.parse(paramsJson)))
    },
  }
  const push = () => { void bridge('core.state', { json: JSON.stringify(snapshotOf(client)) }) }
  watchState(client, push)
  nameJoinedWorkspaces(client.workspaces, client.connections)
  push()
  await bridge('core.ready', {})
}

start().catch((error: unknown) => {
  console.error('Cate core failed to start', error)
  const message = error instanceof Error ? error.message : String(error)
  try { void nativeBridge()('core.failed', { message }) } catch { /* not in the app */ }
})
