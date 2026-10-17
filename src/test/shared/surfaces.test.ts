// Page operations go to a client by the feature each op needs, whatever
// the client is.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerSurface, serveSurfaces } from '@client/host'
import { startSharedWorkspace, until, type SharedWorkspace } from '../sharedWorkspace'

let ws: SharedWorkspace
beforeEach(async () => { ws = await startSharedWorkspace() })
afterEach(async () => { await ws?.stop() })

describe.skipIf(process.platform === 'win32')('shared workspace: surfaces', () => {
  it('a client with only webview runs a chat page operation; a pageDriver op finds no client', async () => {
    const c = await ws.join('W', 'local', ['webview'])
    const stopServing = serveSurfaces({ getSnapshot: () => [c.connection], subscribe: () => () => {} } as never)
    const stopSurface = registerSurface(c.workspaceId, 'chat-1', (request) => `sent ${String((request.args as { text: string }).text)}`)
    try {
      const surfaces = ws.daemon.workspace.surfaces
      await until(() => surfaces.driverFor('chat-1', 'webview') ?? undefined, 5_000, 'W serving')
      await expect(surfaces.request('chat-1', 'chat.sendText', { text: 'hi' }, { feature: 'webview' })).resolves.toBe('sent hi')
      await expect(surfaces.request('b-1', 'page.ready', {}, { feature: 'pageDriver' })).rejects.toMatchObject({ code: 'no-renderer' })
    } finally {
      stopSurface()
      stopServing()
    }
  })
})
