import { describe, expect, it } from 'vitest'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { RpcClient, createRuntimeProxy } from '@kernel/rpc/client'
import { COMPATIBILITY_VERSION, createMemoryPortPair } from '@kernel/rpc/contract'
import { RpcServer, type StreamSink } from '@kernel/rpc/runtime'
import type { WorkspaceConnection, WorkspaceConnections } from '@client/connections'
import { surfaceCapability, type SurfaceRequest } from '@panels/framework/contract'
import { registerSurface, serveSurfaces } from './surfaces'

describe('serveSurfaces', () => {
  it('serves page requests after an incompatible runtime is replaced, and after reconnecting', async () => {
    const rpc = new RpcClient({
      version: '2.0.0',
      identity: { client: { clientId: 'desktop', device: { name: 'Desktop', publicKey: 'key' }, features: ['pageDriver'] } },
    })
    const connection = {
      workspaceId: 'surfaces-reconnect', rpc,
      clientHas: () => true,
      runtime: createRuntimeProxy(rpc, [surfaceCapability]),
    } as unknown as WorkspaceConnection
    const stopServing = serveSurfaces({ getSnapshot: () => [connection], subscribe: () => () => {} } as unknown as WorkspaceConnections)
    const stopSurface = registerSurface(connection.workspaceId, 'browser', () => 'page result')
    const servers: RpcServer[] = []
    let sink: StreamSink<SurfaceRequest> | undefined
    const replies: unknown[] = []
    const connect = async (version: string, compatibilityVersion = COMPATIBILITY_VERSION) => {
      const server = new RpcServer({ lifecycle: createLifecycleBus(), version, compatibilityVersion })
      servers.push(server)
      server.register(surfaceCapability, {
        requests: (_params, next, _ctx) => { sink = next; return () => { sink = undefined } },
        reply: (reply) => { replies.push(reply) },
      })
      const [clientPort, serverPort] = createMemoryPortPair()
      server.serve(serverPort)
      await rpc.attach(clientPort)
    }
    try {
      await connect('1.0.0', COMPATIBILITY_VERSION + 1)
      expect(rpc.state).toBe('incompatible')
      await connect('2.0.0')
      expect(sink).toBeDefined()
      sink!.emit({ requestId: 1, panelId: 'browser', op: 'page.ready' })
      await expect.poll(() => replies).toEqual([{ requestId: 1, result: 'page result' }])
      await connect('2.0.0')
      expect(sink).toBeDefined()
      sink!.emit({ requestId: 2, panelId: 'browser', op: 'page.ready' })
      await expect.poll(() => replies).toHaveLength(2)
    } finally {
      stopSurface()
      stopServing()
      rpc.close()
      for (const server of servers) server.close()
    }
  })
})
