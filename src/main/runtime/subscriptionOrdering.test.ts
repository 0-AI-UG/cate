import { expect, test, vi } from 'vitest'
import { RuntimeRpcClient } from './rpcClient'
import { RemoteRuntime } from './RemoteRuntime'
import { RpcServer } from '../../runtime/rpcServer'
import type { Runtime } from './types'

test.each(['watch', 'search', 'hooks'] as const)('%s subscribes before synchronous first events', async kind => {
  const observer = vi.fn()
  const unsubscribe = vi.fn()
  const api = {
    file: {
      watch: (_root: string, notify: (p: string, t: string) => void) => { notify('/repo/é.ts', 'update'); return unsubscribe },
      searchContent: (_root: string, _opts: unknown, cbs: { onDone: (stats: unknown) => void }) => {
        cbs.onDone({ matches: 0, files: 0, truncated: false }); return { cancel: unsubscribe }
      },
    },
    agentHooks: { subscribe: (notify: (e: unknown) => void) => { notify({ terminalId: 't' }); return unsubscribe } },
  } as unknown as Runtime
  let client!: RuntimeRpcClient
  const output: string[] = []
  const server = new RpcServer(api, line => output.push(line))
  client = new RuntimeRpcClient(line => server.handleChunk(line))
  server.start()
  client.handleChunk(output.splice(0).join(''))
  const remote = new RemoteRuntime('local', client)
  const stop = kind === 'watch' ? remote.file.watch('/repo', observer)
    : kind === 'hooks' ? remote.agentHooks.subscribe(observer)
      : remote.file.searchContent('/repo', { query: 'x' }, { onBatch: vi.fn(), onDone: observer }).cancel
  await Promise.resolve()
  await Promise.resolve()
  client.handleChunk(output.splice(0).join(''))
  await Promise.resolve()
  try { expect(observer).toHaveBeenCalledTimes(1) }
  finally { stop(); server.dispose(); client.dispose() }
})
