// `browserCode`: how a client running a `cate.browser.run` cell passes the
// cell's `cua.*` calls back to the runtime. Each call runs as the cell's
// original caller (`ctx.invoke`), through the same gates, and only while the
// cell is live.

import { defineCapability, method } from '@kernel/rpc/contract'

export const browserCodeCapability = defineCapability('browserCode', {
  methods: {
    call: method<{ cellId: string; method: string; args?: Record<string, unknown> }, unknown>({ mutates: true, timeoutMs: 0 }),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    browserCode: typeof browserCodeCapability
  }
}
