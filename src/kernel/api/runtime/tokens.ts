// Caller tokens. A CLI token is minted per PTY and names the terminal it runs
// in; a harness token is minted per T3 harness and names its chat panel. The
// token comes in the caller's `hello` and identifies the caller for the life
// of the connection.

import { randomBytes } from 'node:crypto'
import type { ApiCaller } from '../contract'

export interface TokenCallerInit {
  kind: 'cli' | 'harness'
  panelId?: string
  /** Defaults to the panel id, so panels a caller creates land next to it. */
  placementGroupId?: string
}

export interface IssuedToken {
  token: string
  caller: ApiCaller
}

const defaultToken = (): string => randomBytes(32).toString('base64url')

export class ApiTokenRegistry {
  private readonly byToken = new Map<string, ApiCaller>()
  private readonly revokeListeners = new Set<(caller: ApiCaller) => void>()
  private counter = 0

  constructor(private readonly mint: () => string = defaultToken) {}

  issue(init: TokenCallerInit): IssuedToken {
    let token = this.mint()
    while (this.byToken.has(token)) token = this.mint()
    this.counter += 1
    const caller: ApiCaller = {
      kind: init.kind,
      id: `${init.kind}:${this.counter}`,
      ...(init.panelId ? { panelId: init.panelId } : {}),
      ...((init.placementGroupId ?? init.panelId) ? { placementGroupId: init.placementGroupId ?? init.panelId } : {}),
    }
    this.byToken.set(token, caller)
    return { token, caller }
  }

  resolve(token: string | undefined): ApiCaller | undefined {
    return token ? this.byToken.get(token) : undefined
  }

  revoke(token: string): void {
    const caller = this.byToken.get(token)
    if (!caller) return
    this.byToken.delete(token)
    for (const listener of this.revokeListeners) listener(caller)
  }

  /** Revokes every token naming `panelId` (its PTY or harness went away). */
  revokePanel(panelId: string): void {
    for (const [token, caller] of [...this.byToken]) {
      if (caller.panelId === panelId) this.revoke(token)
    }
  }

  onRevoke(listener: (caller: ApiCaller) => void): () => void {
    this.revokeListeners.add(listener)
    return () => this.revokeListeners.delete(listener)
  }
}
