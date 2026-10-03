// Test support: a workspace whose document runtime is an in-memory sequencer,
// attached through the real client document store and client state. Ops are
// confirmed synchronously, so a test can act and assert without waiting.

import { RpcError, channel, type ChannelState, type Subscription } from '@kernel/rpc/contract'
import { definePanel, type AnyPanelDefinition } from '@panels/framework/contract'
import {
  applyOp,
  createDocument,
  createSequencer,
  type PanelRecord,
  type PlaceTarget,
  type DocChange,
  type DocumentEvent,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import type { SessionHandle, WorkspaceConnection } from '@client/connections'
import type { SessionSource } from '@client/host'
import { attachDocument, clientStateFor, documentStoreFor, type ClientStateStore, type DocumentStore } from '@client/document'

function subscription<E>(onListen: (emit: (event: E) => void) => () => void): Subscription<E, void> {
  let stop: (() => void) | null = null
  let finish!: () => void
  const done = new Promise<void>((resolve) => { finish = resolve })
  return {
    onEvent(listener) {
      stop = onListen(listener)
      return () => { stop?.() }
    },
    onBytes: () => () => {},
    write: () => {},
    ack: () => {},
    done,
    cancel() {
      stop?.()
      finish()
    },
    async *[Symbol.asyncIterator]() { /* not used */ },
  }
}

export interface TestWorkspace {
  workspaceId: string
  document: DocumentStore
  state: ClientStateStore
  /** The runtime's confirmed document. */
  confirmed(): WorkspaceDocument
  /** Applies a change as another client would (through the runtime). */
  remote(change: DocChange): void
  detach(): void
}

let remoteCounter = 0

export function attachTestWorkspace(workspaceId: string, doc: WorkspaceDocument = createDocument()): TestWorkspace {
  const sequencer = createSequencer({ doc })
  const listeners = new Set<(event: DocumentEvent) => void>()
  const broadcast = (event: DocumentEvent) => { for (const listener of [...listeners]) listener(event) }
  const connection = {
    workspaceId,
    clientId: `test-${workspaceId}`,
    rpc: { onReady: () => () => {} },
    runtime: {
      document: {
        apply: async ({ op }: { op: Parameters<typeof sequencer.submit>[0] }) => {
          const result = sequencer.submit(op)
          if (result.status === 'failed') throw new RpcError(result.error.code, result.error.message)
          if (result.status === 'applied') broadcast({ kind: 'op', seq: result.seq, op })
          return result.status === 'applied' ? { status: 'applied' as const, seq: result.seq } : { status: 'duplicate' as const }
        },
        subscribe: () => subscription<DocumentEvent>((emit) => {
          emit({ kind: 'doc', seq: sequencer.seq, doc: sequencer.doc })
          listeners.add(emit)
          return () => { listeners.delete(emit) }
        }),
      },
      presence: { report: async () => {} },
    },
  } as unknown as WorkspaceConnection
  const detach = attachDocument(connection)
  return {
    workspaceId,
    document: documentStoreFor(workspaceId)!,
    state: clientStateFor(workspaceId)!,
    confirmed: () => sequencer.doc,
    remote(change) {
      const op = { ...change, opId: { clientId: 'other', counter: ++remoteCounter } }
      const result = sequencer.submit(op as Parameters<typeof sequencer.submit>[0])
      if (result.status === 'applied') broadcast({ kind: 'op', seq: result.seq, op: op as Parameters<typeof sequencer.submit>[0] })
    },
    detach,
  }
}

// --- Panel definitions for tests -----------------------------------------------------

const base = (type: string, extra: Partial<AnyPanelDefinition> = {}): AnyPanelDefinition => definePanel({
  type: type as AnyPanelDefinition['type'],
  label: type[0].toUpperCase() + type.slice(1),
  icon: 'terminal',
  defaultSize: { width: 600, height: 400 },
  minimumSize: { width: 320, height: 220 },
  dropSize: { width: 480, height: 320 },
  canLiveOnCanvas: true,
  defaultTitle: type,
  channel: channel<Record<string, never>>(),
  ...extra,
})

/** Terminal, editor, browser (a surface), canvas and surface. */
export function testPanelDefinitions(): AnyPanelDefinition[] {
  return [
    base('terminal', { creation: { order: 1 }, opens: ['directory'], chrome: { worktreeChip: true } }),
    base('editor', { icon: 'folders', creation: { order: 2 }, opens: ['file'], chrome: { flushTabBar: true } }),
    base('browser', { icon: 'globe', opens: ['url'], surface: { retention: 'workspace' } }),
    base('canvas', { icon: 'grid', canLiveOnCanvas: false, chrome: { floatingTabBar: true } }),
    base('surface', { icon: 'plus', placeholder: true }),
  ]
}

let seedCounter = 0

/** A document built by applying changes to an empty one; throws on a refused
 *  change so a broken fixture fails loudly. */
export function buildDocument(changes: DocChange[], doc: WorkspaceDocument = createDocument()): WorkspaceDocument {
  for (const change of changes) {
    const result = applyOp(doc, { ...change, opId: { clientId: 'seed', counter: ++seedCounter } } as Parameters<typeof applyOp>[1])
    if (result.error) throw new Error(`${change.kind}: ${result.error.message}`)
    doc = result.doc
  }
  return doc
}

export const record = (id: string, type = 'terminal', extra: Partial<PanelRecord> = {}): PanelRecord => ({
  id,
  type: type as PanelRecord['type'],
  title: id,
  fields: {},
  ...extra,
})

export const add = (id: string, at: PlaceTarget, type = 'terminal', extra: Partial<PanelRecord> = {}): DocChange => ({
  kind: 'addPanel',
  record: record(id, type, extra),
  at,
})

// --- Fake session channels ------------------------------------------------------------

export interface FakeSessions {
  source: SessionSource
  /** Open references per panel. */
  refs(panelId: string): number
  /** Publishes a snapshot to every view of the panel. */
  publish(panelId: string, snapshot: unknown): void
  sent: { panelId: string; op: unknown }[]
}

export function fakeSessions(): FakeSessions {
  const state = new Map<string, { snapshot: ChannelState<unknown> | null; listeners: Set<() => void>; refs: number }>()
  const entry = (panelId: string) => {
    let e = state.get(panelId)
    if (!e) state.set(panelId, e = { snapshot: null, listeners: new Set(), refs: 0 })
    return e
  }
  const sent: { panelId: string; op: unknown }[] = []
  const source: SessionSource = {
    acquire(_workspaceId, panelId) {
      const e = entry(panelId)
      e.refs++
      let released = false
      const handle: SessionHandle = {
        panelId,
        getSnapshot: () => e.snapshot,
        subscribe: (listener) => {
          e.listeners.add(listener)
          return () => { e.listeners.delete(listener) }
        },
        send: async (op) => { sent.push({ panelId, op }) },
        write: () => {},
        onBytes: () => () => {},
        release: () => {
          if (released) return
          released = true
          e.refs--
        },
      }
      return handle
    },
    owner: () => source,
    subscribe: () => () => {},
  }
  return {
    source,
    refs: (panelId) => state.get(panelId)?.refs ?? 0,
    publish(panelId, snapshot) {
      const e = entry(panelId)
      e.snapshot = { rev: (e.snapshot?.rev ?? 0) + 1, snapshot }
      for (const listener of [...e.listeners]) listener()
    },
    sent,
  }
}
