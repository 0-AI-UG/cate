import { buildDaemonRuntime } from '../../runtime/capabilities'
import { RpcServer } from '../../runtime/rpcServer'
import { RuntimeRpcClient } from './rpcClient'
import { RemoteRuntime } from './RemoteRuntime'
import { LOCAL_RUNTIME_ID, type RuntimeId } from './locator'
import type { Runtime } from './types'
import { runtimes } from './runtimeManager'

/** Wrap a daemon Runtime in an in-process loopback RemoteRuntime — the same
 *  client every production caller goes through (including its trusted-caller
 *  scope default for access-less main-process calls), over the real LF-JSON
 *  framing, without a subprocess. */
export function loopbackRuntime(api: Runtime, id: RuntimeId): Runtime {
  // Forward reference: `server` closes over `client`, so it's declared first.
  // eslint-disable-next-line prefer-const
  let client!: RuntimeRpcClient
  const server = new RpcServer(api, (line) => client.handleChunk(line))
  client = new RuntimeRpcClient((line) => server.handleChunk(line))
  server.start()
  return new RemoteRuntime(id, client)
}

/** Register the production daemon capability assembly in-process for IPC tests,
 *  reached through a loopback RemoteRuntime exactly like production. */
export function registerTestDaemonRuntime(exclusions: string[] = []): Runtime {
  const runtime = loopbackRuntime(
    buildDaemonRuntime({ id: LOCAL_RUNTIME_ID, exclusions }).runtime,
    LOCAL_RUNTIME_ID,
  )
  runtimes.registerLocalForTest(runtime)
  return runtime
}
