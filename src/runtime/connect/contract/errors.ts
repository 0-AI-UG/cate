export type CateConnectErrorCode = 'unreachable' | 'offline' | 'refused' | 'no-path' | 'protocol'

export class CateConnectError extends Error {
  constructor(readonly code: CateConnectErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** What the user sees when ICE found no path, neither direct nor through the
 *  service's TURN relay. */
export const CONNECTION_FAILED = 'Could not connect through Cate Connect; try same network.'
