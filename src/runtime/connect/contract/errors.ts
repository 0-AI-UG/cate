export type CateConnectErrorCode = 'unreachable' | 'offline' | 'refused' | 'direct-failed' | 'protocol'

export class CateConnectError extends Error {
  constructor(readonly code: CateConnectErrorCode, message: string) {
    super(message)
  }
}

/** What the user sees when no direct path exists (no relay, by design). */
export const DIRECT_CONNECTION_FAILED = 'Could not connect directly; try same network.'
