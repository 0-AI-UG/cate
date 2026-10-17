// A client's optimistic copy of the document (section 13.5). It holds the
// confirmed document (the runtime's, up to `seq`) and this client's
// unconfirmed ops. What the client renders is the confirmed document with
// the unconfirmed ops applied on top, rebuilt whenever the runtime moves.

import { applyOp } from './apply'
import { sameOpId, type DocOp, type OpId, type OpResult } from './ops'
import type { ClientId, WorkspaceDocument } from './schema'

export interface Mirror {
  /** Confirmed document plus unconfirmed ops: what the client shows. */
  readonly doc: WorkspaceDocument
  readonly confirmed: WorkspaceDocument
  readonly seq: number
  /** Unconfirmed ops in send order; resend all of them after reconnecting. */
  readonly pending: readonly DocOp[]
  /** Apply a local op at once. On error nothing is queued and the op should
   *  not be sent. */
  propose(op: DocOp): OpResult<WorkspaceDocument>
  /** An op the runtime applied as `seq`. `before` is the confirmed document
   *  it applied to (undo computes inverses against it); `mine` says whether
   *  this client sent it. `stale` for a seq already seen, `gap` when ops
   *  were missed and the client must resync. */
  applied(seq: number, op: DocOp): { before: WorkspaceDocument; mine: boolean } | 'stale' | 'gap'
  /** The runtime refused an op (failed or duplicate): drop it. */
  refused(opId: OpId): void
  /** Replace the confirmed state with a full document from the runtime.
   *  Unconfirmed ops stay queued. */
  reset(doc: WorkspaceDocument, seq: number): void
}

export function createMirror(clientId: ClientId, doc: WorkspaceDocument, seq: number): Mirror {
  let confirmed = doc
  let confirmedSeq = seq
  let pending: DocOp[] = []
  let view = doc

  const rebuild = () => {
    view = pending.reduce((current, op) => applyOp(current, op).doc, confirmed)
  }

  return {
    get doc() { return view },
    get confirmed() { return confirmed },
    get seq() { return confirmedSeq },
    get pending() { return pending },
    propose(op) {
      const result = applyOp(view, op)
      if (result.error) return result
      pending = [...pending, op]
      view = result.doc
      return result
    },
    applied(at, op) {
      if (at <= confirmedSeq) return 'stale'
      if (at !== confirmedSeq + 1) return 'gap'
      const before = confirmed
      confirmed = applyOp(confirmed, op).doc
      confirmedSeq = at
      const mine = op.opId.clientId === clientId
      if (mine) pending = pending.filter((p) => !sameOpId(p.opId, op.opId))
      rebuild()
      return { before, mine }
    },
    refused(opId) {
      const next = pending.filter((p) => !sameOpId(p.opId, opId))
      if (next.length === pending.length) return
      pending = next
      rebuild()
    },
    reset(next, at) {
      confirmed = next
      confirmedSeq = at
      rebuild()
    },
  }
}
