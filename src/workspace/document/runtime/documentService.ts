// The runtime side of the document (9.1): holds it in memory, applies ops one
// at a time in arrival order, persists document.json with the seq and the
// per-client op counters (so a resend after a restart is not applied twice),
// and tells every listener about every applied op.

import fs from 'node:fs'
import { createLogger, type Logger } from '@kernel/log/contract'
import { isRpcError, RpcError } from '@kernel/rpc/contract'
import { quarantineCorruptFile, writeJsonAtomic, writeJsonAtomicSync } from '@kernel/state/node'
import {
  DOCUMENT_FILE_VERSION,
  RUNTIME_CLIENT_ID,
  createDocument,
  createSequencer,
  opChanges,
  panelsInWindow,
  removalSet,
  parseDocument,
  type AppliedOp,
  type DocBatch,
  type DocChange,
  type DocOp,
  type PanelId,
  type SubmitResult,
  type WorkspaceDocument,
} from '../contract'

export interface AppliedEvent {
  seq: number
  op: DocOp
  /** The document the op applied to. */
  before: WorkspaceDocument
  doc: WorkspaceDocument
}

export interface DocumentService {
  get(): WorkspaceDocument
  readonly seq: number
  /** New at every start (the sequencer's epoch). */
  readonly epoch: string
  /** A client's op, deduped on its opId. A removal the removal guard refuses
   *  fails with its code (`dirty`). */
  submit(op: DocOp): SubmitResult
  /** Who decides whether removing panels loses work (the session host): it
   *  gets the whole removal set and the panels whose work may go, and throws
   *  an `RpcError` to refuse. One guard; the last one set wins. */
  guardRemovals(guard: RemovalGuard | null): void
  /** An op the runtime makes itself, with a runtime opId. Returns its seq;
   *  throws `RpcError` (`gone`, `rejected`) when it fails. */
  apply(change: DocChange | DocBatch): number
  /** The ops after `seq` of `epoch`, or null when the client needs the full
   *  document. */
  since(seq: number, epoch: string): AppliedOp[] | null
  /** Runs synchronously after each applied op, in order. */
  subscribe(listener: (event: AppliedEvent) => void): () => void
  /** Writes pending changes now. */
  flush(): Promise<void>
  /** Writes pending changes synchronously and stops. */
  dispose(): void
}

export type RemovalGuard = (removing: ReadonlySet<PanelId>, discard: ReadonlySet<PanelId>) => void

export interface DocumentServiceOptions {
  /** `dataPaths(dir).document`. */
  file: string
  debounceMs?: number
  /** Applied ops kept for reconnects. */
  keep?: number
  log?: Logger
}

/** document.json. The seq and counters sit next to the document. */
interface DocumentFileData {
  version: typeof DOCUMENT_FILE_VERSION
  seq: number
  counters: Record<string, number>
  document: WorkspaceDocument
}

interface Loaded {
  doc: WorkspaceDocument
  seq: number
  counters: [string, number][]
}

function load(file: string, log: Logger): Loaded {
  const fresh: Loaded = { doc: createDocument(), seq: 0, counters: [] }
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return fresh
  }
  const parsed = parseDocument(text)
  if (!parsed.ok) {
    const backup = quarantineCorruptFile(file)
    log.error('document.json is invalid (%s); moved to %s, starting empty', parsed.error, backup ?? '(backup failed)')
    return fresh
  }
  const raw = JSON.parse(text) as Partial<DocumentFileData>
  const seq = Number.isSafeInteger(raw.seq) && raw.seq! >= 0 ? raw.seq! : 0
  const counters = Object.entries(raw.counters && typeof raw.counters === 'object' ? raw.counters : {})
    .filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && entry[1] > 0)
  return { doc: parsed.doc, seq, counters }
}

export function createDocumentService(options: DocumentServiceOptions): DocumentService {
  const log = options.log ?? createLogger('document')
  const debounceMs = options.debounceMs ?? 250
  const initial = load(options.file, log)
  const sequencer = createSequencer({ ...initial, keep: options.keep })
  const listeners = new Set<(event: AppliedEvent) => void>()
  let removalGuard: RemovalGuard | null = null
  let runtimeCounter = sequencer.counters.get(RUNTIME_CLIENT_ID) ?? 0

  // Every submit may change the document or a counter: bump `version`, and
  // write until the file holds the latest one.
  let version = 0
  let written = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> | null = null
  let disposed = false

  const snapshot = (): DocumentFileData => ({
    version: DOCUMENT_FILE_VERSION,
    seq: sequencer.seq,
    counters: Object.fromEntries(sequencer.counters),
    document: sequencer.doc,
  })

  const writeLoop = async (): Promise<void> => {
    while (written < version) {
      const target = version
      await writeJsonAtomic(options.file, snapshot())
      written = target
    }
  }

  const flush = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null }
    writing ??= writeLoop().finally(() => { writing = null })
    return writing
  }

  const schedule = () => {
    version++
    if (disposed || timer) return
    timer = setTimeout(() => {
      timer = null
      flush().catch((err) => log.warn('writing document.json failed: %s', (err as Error).message))
    }, debounceMs)
  }

  const submit = (op: DocOp): SubmitResult => {
    if (disposed) return { status: 'failed', error: { code: 'rejected', message: 'the runtime is stopping' } }
    const before = sequencer.doc
    const result = sequencer.submit(op)
    if (result.status === 'duplicate') return result
    schedule()
    if (result.status === 'applied') {
      const event: AppliedEvent = { seq: result.seq, op, before, doc: sequencer.doc }
      for (const listener of [...listeners]) {
        try { listener(event) } catch (err) { log.error('document listener failed: %O', err) }
      }
    }
    return result
  }

  return {
    get: () => sequencer.doc,
    get seq() { return sequencer.seq },
    get epoch() { return sequencer.epoch },
    submit(op) {
      if (removalGuard) {
        for (const change of opChanges(op)) {
          if (change.kind !== 'removePanels' && change.kind !== 'closeWindow') continue
          const ids = change.kind === 'removePanels' ? change.ids : panelsInWindow(sequencer.doc, change.windowId)
          try {
            removalGuard(removalSet(sequencer.doc, ids), new Set(change.discard ?? []))
          } catch (err) {
            if (!isRpcError(err)) throw err
            const code = err.code === 'dirty' || err.code === 'gone' ? err.code : 'rejected'
            return { status: 'failed', error: { code, message: err.message } }
          }
        }
      }
      return submit(op)
    },
    guardRemovals(guard) { removalGuard = guard },
    apply(change) {
      const op = { ...change, opId: { clientId: RUNTIME_CLIENT_ID, counter: ++runtimeCounter } } as DocOp
      const result = submit(op)
      if (result.status === 'failed') throw new RpcError(result.error.code, result.error.message)
      if (result.status === 'duplicate') throw new RpcError('rejected', 'runtime op counter reused')
      return result.seq
    },
    since: (seq, epoch) => sequencer.since(seq, epoch),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    flush,
    dispose() {
      if (disposed) return
      disposed = true
      if (timer) { clearTimeout(timer); timer = null }
      listeners.clear()
      if (written < version) {
        try {
          writeJsonAtomicSync(options.file, snapshot())
          written = version
        } catch (err) {
          log.error('writing document.json on stop failed: %s', (err as Error).message)
        }
      }
    },
  }
}
