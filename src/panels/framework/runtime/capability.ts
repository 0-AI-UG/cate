import { RpcError } from '@kernel/rpc/contract'
import type { CallContext, CapabilityImpl } from '@kernel/rpc/runtime'
import type { PanelId } from '@workspace/document/contract'
import type { sessionCapability } from '../contract'
import type { OpContext } from './PanelSession'
import type { SessionHost } from './sessionHost'

const opContext = (ctx: CallContext): OpContext => ({
  clientId: ctx.connection.client?.clientId ?? null,
  connectionId: ctx.connection.id,
})

export function sessionCapabilityImpl(deps: {
  host: SessionHost
  /** Showing or using a panel makes a client its most recent user. */
  presence?: { usedPanel(connectionId: number, panelId: PanelId): void }
}): CapabilityImpl<typeof sessionCapability> {
  const { host, presence } = deps
  return {
    op: ({ panelId, op }, ctx) => {
      presence?.usedPanel(ctx.connection.id, panelId)
      return host.op(panelId, op, opContext(ctx))
    },
    subscribe: ({ panelId }, sink, ctx) => {
      const detach = host.subscribe(panelId, {
        snapshot: (rev, snapshot) => sink.emit({ kind: 'snapshot', rev, snapshot }),
        change: (rev, change) => sink.emit({ kind: 'change', rev, change }),
        gone: () => sink.fail(new RpcError('gone', `panel ${panelId} is gone`)),
      })
      presence?.usedPanel(ctx.connection.id, panelId)
      return detach
    },
  }
}
