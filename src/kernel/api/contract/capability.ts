// The `api` capability: how callers reach the router over the runtime
// protocol. The CLI and T3 harnesses connect with their token; clients call it
// from their own connection. The router enforces each method's timeout, so the
// capability declares none; callers pass one per call.

import { defineCapability, method } from '@kernel/rpc/contract'

export interface ApiCallParams {
  /** Full wire name (`cate.terminal.read`). */
  method: string
  /** Named arguments. A session method's target is the `panelId` argument. */
  args?: Record<string, unknown>
}

export const apiCapability = defineCapability('api', {
  methods: {
    call: method<ApiCallParams, unknown>({ mutates: true, timeoutMs: 0 }),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    api: typeof apiCapability
  }
}
