import { RpcError } from '@kernel/rpc/contract'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import type { documentCapability, presenceCapability } from '../contract'
import type { DocumentService } from './documentService'
import type { PresenceService } from './presence'

export function documentCapabilityImpl(
  document: DocumentService,
  presence?: PresenceService,
): CapabilityImpl<typeof documentCapability> {
  return {
    apply: ({ op }, ctx) => {
      const client = ctx.connection.client
      if (!client) throw new RpcError('rejected', 'only clients send document ops')
      if (op?.opId?.clientId !== client.clientId) throw new RpcError('rejected', 'the op names another client')
      presence?.touch(ctx.connection.id)
      const result = document.submit(op)
      if (result.status === 'failed') throw new RpcError(result.error.code, result.error.message)
      return result
    },
    subscribe: ({ sinceSeq, epoch } = {}, sink) => {
      // Catch-up and registration happen in one turn, so no op falls between.
      const missed = typeof sinceSeq === 'number' && typeof epoch === 'string' ? document.since(sinceSeq, epoch) : null
      if (missed) for (const { seq, op } of missed) sink.emit({ kind: 'op', seq, op })
      else sink.emit({ kind: 'doc', seq: document.seq, epoch: document.epoch, doc: document.get() })
      return document.subscribe(({ seq, op }) => sink.emit({ kind: 'op', seq, op }))
    },
  }
}

export function presenceCapabilityImpl(presence: PresenceService): CapabilityImpl<typeof presenceCapability> {
  return {
    report: (report, ctx) => { presence.report(ctx.connection.id, report ?? {}) },
    subscribe: (_params, sink) => {
      sink.emit({ clients: presence.clients(), activeClientId: presence.activeClient()?.clientId ?? null })
      return presence.subscribe((event) => sink.emit(event))
    },
  }
}
