/** Shared by the runtime, desktop, mobile and CLI. Bump only when existing
 *  clients can no longer safely use the protocol; release bumps leave it alone. */
export const COMPATIBILITY_VERSION = 2

export function isCompatible(remote: unknown, local: number): boolean {
  return Number.isSafeInteger(remote) && remote === local
}
