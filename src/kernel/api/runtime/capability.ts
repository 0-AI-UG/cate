// Serves the `api` capability on the daemon's rpc server: identifies the
// caller from the connection (a caller token or a client) and hands the call
// to the router.

import { RpcError, type HelloMessage } from '@kernel/rpc/contract'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import { apiCapability, type ApiCaller } from '../contract'
import type { ApiRouter } from './router'

type ConnectionLike = {
  caller: { token: string } | null
  client: { clientId: string } | null
}

export function callerForConnection(router: ApiRouter, connection: ConnectionLike): ApiCaller {
  if (connection.caller) {
    const caller = router.callerForToken(connection.caller.token)
    if (!caller) throw new RpcError('rejected', 'unknown or revoked cate token')
    return caller
  }
  if (connection.client) return router.clientCaller(connection.client.clientId)
  throw new RpcError('rejected', 'unidentified connection')
}

export function apiCapabilityImpl(router: ApiRouter): CapabilityImpl<typeof apiCapability> {
  return {
    call: ({ method, args }, ctx) =>
      router.call(callerForConnection(router, ctx.connection), method, args ?? {}, { signal: ctx.signal }),
  }
}

/** For `RpcServerOptions.acceptHello`: refuses a caller whose token is unknown.
 *  Client hellos are left to the transport's own checks. */
export function acceptCallerHello(router: ApiRouter, hello: HelloMessage): void {
  if (hello.caller && !router.callerForToken(hello.caller.token)) {
    throw new RpcError('rejected', 'unknown or revoked cate token')
  }
}
