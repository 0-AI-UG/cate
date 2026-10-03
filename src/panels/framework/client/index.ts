// A client with `pageDriver` answers the runtime's page operations. Session
// channels are `subscribeSession` in `client/connections`.

import { toWireError, type CapabilityProxy } from '@kernel/rpc/contract'
import type { SurfaceRequest, surfaceCapability } from '../contract'

/** Runs the runtime's page operations on this client's surfaces. Only for
 *  clients that declare `pageDriver`. */
export function serveSurfaceRequests(
  surface: CapabilityProxy<typeof surfaceCapability>,
  run: (request: SurfaceRequest) => unknown | Promise<unknown>,
): () => void {
  const sub = surface.requests(undefined, { resume: true })
  sub.onEvent((request) => {
    void Promise.resolve()
      .then(() => run(request))
      .then(
        (result) => surface.reply({ requestId: request.requestId, result }),
        (err) => surface.reply({ requestId: request.requestId, error: toWireError(err) }),
      )
      .catch(() => { /* the connection dropped; the runtime fails the request */ })
  })
  return () => sub.cancel()
}
