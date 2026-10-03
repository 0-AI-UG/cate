// The runtime's ordering of document ops (sections 9.1 and 13.4): apply in
// arrival order, number every applied op, apply each opId at most once, and
// keep the last `keep` applied ops for reconnecting clients.

import { applyOp } from './apply'
import type { DocOp, OpError, OpId } from './ops'
import type { ClientId, WorkspaceDocument } from './schema'

export interface AppliedOp {
  seq: number
  op: DocOp
}

export type SubmitResult =
  | { status: 'applied'; seq: number }
  | { status: 'failed'; error: OpError }
  /** Already handled (applied or failed) before; nothing changed. */
  | { status: 'duplicate' }

export interface Sequencer {
  readonly doc: WorkspaceDocument
  /** The seq of the last applied op; 0 before any. */
  readonly seq: number
  /** The highest counter handled per client. Persist it with the document so
   *  a restart does not apply a resent op twice. */
  readonly counters: ReadonlyMap<ClientId, number>
  submit(op: DocOp): SubmitResult
  /** The ops applied after `seq`, or null when they are no longer kept (or
   *  `seq` is unknown) and the client needs the full document. */
  since(seq: number): AppliedOp[] | null
}

export interface SequencerInit {
  doc: WorkspaceDocument
  seq?: number
  counters?: Iterable<[ClientId, number]>
  keep?: number
}

function isValidOpId(opId: unknown): opId is OpId {
  if (typeof opId !== 'object' || opId === null) return false
  const { clientId, counter } = opId as OpId
  return typeof clientId === 'string' && clientId.length > 0 && Number.isSafeInteger(counter) && counter > 0
}

export function createSequencer(init: SequencerInit): Sequencer {
  let doc = init.doc
  let seq = init.seq ?? 0
  const keep = init.keep ?? 10_000
  const counters = new Map(init.counters ?? [])
  let log: AppliedOp[] = []

  return {
    get doc() { return doc },
    get seq() { return seq },
    get counters() { return counters },
    submit(op) {
      if (!isValidOpId(op?.opId)) return { status: 'failed', error: { code: 'rejected', message: 'op has no valid opId' } }
      const { clientId, counter } = op.opId
      if (counter <= (counters.get(clientId) ?? 0)) return { status: 'duplicate' }
      counters.set(clientId, counter)
      const result = applyOp(doc, op)
      if (result.error) return { status: 'failed', error: result.error }
      doc = result.doc
      seq += 1
      log.push({ seq, op })
      if (log.length > keep * 2) log = log.slice(-keep)
      return { status: 'applied', seq }
    },
    since(from) {
      if (from === seq) return []
      if (from > seq || from < 0) return null
      const kept = log.length > keep ? log.slice(-keep) : log
      if (kept.length === 0 || kept[0].seq > from + 1) return null
      return kept.filter((entry) => entry.seq > from)
    },
  }
}
