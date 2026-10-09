// The client's mirror of one workspace's document (12.1, 13.4-13.6). Local
// ops apply at once on top of the confirmed document and go to the runtime;
// the runtime's ops rebuild the view. After a reconnect the subscription
// resumes from the last seq and unconfirmed ops go out again (their opIds make
// that safe). Undo covers this client's own confirmed ops.

import { isRpcError, type Subscription } from '@kernel/rpc/contract'
import {
  applicable,
  createDocument,
  createMirror,
  invertOp,
  type DocBatch,
  type DocChange,
  type DocOp,
  type OpId,
  type ApplyResult,
  type DocumentEvent,
  type WorkspaceDocument,
} from '@workspace/document/contract'

/** The part of the `document` proxy the store uses. */
export interface DocumentRemote {
  apply(params: { op: DocOp }): Promise<ApplyResult>
  subscribe(params: { sinceSeq?: number }): Subscription<DocumentEvent, void>
}

export interface DocumentLink {
  clientId: string
  /** The next op counter of `clientId`, from its identity (never restarts). */
  nextCounter(): number
  remote: DocumentRemote
  /** Runs after each successful hello, before queued calls go out. */
  onReady(listener: (info: { reconnect: boolean }) => void): () => void
}

/** An op that was dropped, and why. `local`: it failed on this client's view
 *  and was never sent. */
export interface RefusedOp {
  op: DocOp
  code: string
  message: string
  local: boolean
}

export type ProposeResult = { ok: true; opId: OpId } | { ok: false; refused: RefusedOp }

export interface ProposeOptions {
  /** Goes on this client's undo stack once confirmed. Default true. */
  undoable?: boolean
}

export interface UndoState {
  canUndo: boolean
  canRedo: boolean
}

export interface DocumentStore {
  /** The confirmed document with this client's unconfirmed ops on top. */
  getSnapshot(): WorkspaceDocument
  subscribe(listener: () => void): () => void
  /** Resolves with the first full document from the runtime. */
  readonly ready: Promise<void>
  isSynced(): boolean
  readonly seq: number
  readonly pending: readonly DocOp[]
  propose(change: DocChange | DocBatch, opts?: ProposeOptions): ProposeResult
  undo(): boolean
  redo(): boolean
  getUndoState(): UndoState
  onRefused(listener: (refused: RefusedOp) => void): () => void
  dispose(): void
}

type Origin = 'do' | 'undo' | 'redo'

const UNDO_LIMIT = 200
const opKey = (opId: OpId) => `${opId.clientId}:${opId.counter}`
const newId = () => globalThis.crypto.randomUUID()

export function createDocumentStore(link: DocumentLink): DocumentStore {
  const mirror = createMirror(link.clientId, createDocument(), 0)
  const listeners = new Set<() => void>()
  const refusedListeners = new Set<(refused: RefusedOp) => void>()
  const inFlight = new Set<string>()
  const origins = new Map<string, Origin>()
  let undoStack: DocChange[][] = []
  let redoStack: DocChange[][] = []
  let undoState: UndoState = { canUndo: false, canRedo: false }
  let synced = false
  let disposed = false
  let sub: Subscription<DocumentEvent, void> | null = null
  let markReady!: () => void
  const ready = new Promise<void>((resolve) => { markReady = resolve })

  // Same object while the flags are unchanged (a useSyncExternalStore snapshot).
  const readUndoState = (): UndoState => {
    const canUndo = undoStack.length > 0
    const canRedo = redoStack.length > 0
    if (canUndo !== undoState.canUndo || canRedo !== undoState.canRedo) undoState = { canUndo, canRedo }
    return undoState
  }

  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener() } catch { /* isolate listeners */ }
    }
  }

  const report = (refused: RefusedOp) => {
    for (const listener of [...refusedListeners]) {
      try { listener(refused) } catch { /* isolate listeners */ }
    }
  }

  const resubscribe = () => {
    sub?.cancel()
    sub = null
    if (!disposed) open()
  }

  const open = () => {
    const next = link.remote.subscribe(synced ? { sinceSeq: mirror.seq } : {})
    sub = next
    next.onEvent((event) => { if (sub === next) onEvent(event) })
    next.done.then(
      () => { if (sub === next) sub = null },
      () => { if (sub === next) sub = null },
    )
  }

  const onEvent = (event: DocumentEvent) => {
    if (event.kind === 'doc') {
      mirror.reset(event.doc, event.seq)
      if (!synced) {
        synced = true
        markReady()
      }
      notify()
      return
    }
    const outcome = mirror.applied(event.seq, event.op)
    if (outcome === 'stale') return
    if (outcome === 'gap') {
      resubscribe()
      return
    }
    if (outcome.mine) confirmed(outcome.before, event.op)
    notify()
  }

  const confirmed = (before: WorkspaceDocument, op: DocOp) => {
    const key = opKey(op.opId)
    const origin = origins.get(key)
    origins.delete(key)
    if (!origin) return
    const inverse = invertOp(before, op, newId)
    if (inverse.length === 0) return
    if (origin === 'undo') {
      redoStack = [...redoStack, inverse]
    } else {
      undoStack = [...undoStack, inverse].slice(-UNDO_LIMIT)
      if (origin === 'do') redoStack = []
    }
  }

  const drop = (op: DocOp, code: string, message: string) => {
    origins.delete(opKey(op.opId))
    const before = mirror.pending.length
    mirror.refused(op.opId)
    if (mirror.pending.length === before) return
    notify()
    report({ op, code, message, local: false })
  }

  const forget = (op: DocOp) => {
    origins.delete(opKey(op.opId))
    const before = mirror.pending.length
    mirror.refused(op.opId)
    if (mirror.pending.length !== before) notify()
  }

  const send = (op: DocOp) => {
    const key = opKey(op.opId)
    inFlight.add(key)
    link.remote.apply({ op }).then(
      (result) => {
        inFlight.delete(key)
        if (disposed) return
        if (!result?.status) drop(op, 'rejected', 'The runtime gave no outcome for the op')
        // Handled before: either its op already arrived, or it failed while
        // this client was away. Either way it is no longer pending.
        else if (result.status === 'duplicate') forget(op)
      },
      (err: unknown) => {
        inFlight.delete(key)
        if (disposed) return
        if (isRpcError(err, 'timeout')) send(op)
        else if (isRpcError(err, 'duplicate')) forget(op)
        else if (isRpcError(err)) drop(op, err.code, err.message)
        // Otherwise the connection went: it stays pending and goes again on reconnect.
      },
    )
  }

  const propose = (change: DocChange | DocBatch, origin: Origin | null): ProposeResult => {
    const op = { ...change, opId: { clientId: link.clientId, counter: link.nextCounter() } } as DocOp
    const result = mirror.propose(op)
    if (result.error) {
      const refused: RefusedOp = { op, code: result.error.code, message: result.error.message, local: true }
      report(refused)
      return { ok: false, refused }
    }
    if (origin) origins.set(opKey(op.opId), origin)
    send(op)
    notify()
    return { ok: true, opId: op.opId }
  }

  /** Pops entries until one still applies; sends it as a new op. */
  const replay = (from: 'undo' | 'redo'): boolean => {
    for (;;) {
      const stack = from === 'undo' ? undoStack : redoStack
      const entry = stack[stack.length - 1]
      if (!entry) return false
      if (from === 'undo') undoStack = undoStack.slice(0, -1)
      else redoStack = redoStack.slice(0, -1)
      const changes = applicable(mirror.doc, entry)
      if (changes.length === 0) {
        notify()
        continue
      }
      const result = propose({ kind: 'batch', changes }, from)
      if (result.ok) return true
    }
  }

  const stopReady = link.onReady(() => {
    if (disposed) return
    if (!sub) open()
    for (const op of mirror.pending) if (!inFlight.has(opKey(op.opId))) send(op)
  })

  open()

  return {
    getSnapshot: () => mirror.doc,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    ready,
    isSynced: () => synced,
    get seq() { return mirror.seq },
    get pending() { return mirror.pending },
    propose: (change, opts = {}) => propose(change, opts.undoable === false ? null : 'do'),
    undo: () => replay('undo'),
    redo: () => replay('redo'),
    getUndoState: readUndoState,
    onRefused(listener) {
      refusedListeners.add(listener)
      return () => { refusedListeners.delete(listener) }
    },
    dispose() {
      if (disposed) return
      disposed = true
      stopReady()
      sub?.cancel()
      sub = null
      listeners.clear()
      refusedListeners.clear()
    },
  }
}
