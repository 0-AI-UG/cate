// Test support: opens a workspace document backed by an in-memory runtime
// that applies every op, so views read and write through the real client
// document store.

import type { WorkspaceConnection } from '@client/connections'
import { attachDocument, documentStoreFor, subscribeDocumentStores } from '@client/document'
import { installRelationUiHost, type RelationPanelKind, type RelationUiHost } from '@workspace/relations/ui'
import { applyOp, type DocOp, type DocumentEvent, type WorkspaceDocument } from '@workspace/document/contract'

export function openTestDocument(workspaceId: string, doc: WorkspaceDocument): () => void {
  let current = doc
  let seq = 0
  let emit: ((event: DocumentEvent) => void) | null = null
  const connection = {
    workspaceId,
    clientId: 'test-client',
    rpc: { onReady: () => () => {} },
    runtime: {
      document: {
        apply: async ({ op }: { op: DocOp }) => {
          const result = applyOp(current, op)
          if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code })
          current = result.doc
          seq++
          queueMicrotask(() => emit?.({ kind: 'op', seq, op }))
          return { status: 'applied' as const, seq }
        },
        subscribe: () => ({
          onEvent(listener: (event: DocumentEvent) => void) {
            emit = listener
            listener({ kind: 'doc', seq, doc: current })
            return () => { emit = null }
          },
          done: new Promise<void>(() => {}),
          cancel() { emit = null },
        }),
      },
      presence: { report: async () => {} },
    },
  } as unknown as WorkspaceConnection
  const detach = attachDocument(connection)
  if (!documentStoreFor(workspaceId)) throw new Error('document did not attach')
  return detach
}

/** A relation UI host over the client document registry, with in-memory
 *  settings, for tests. */
export function testRelationHost(options: {
  definitions?: RelationPanelKind[]
  createPanel?: RelationUiHost['createPanel']
  labels?: string[]
  enabled?: boolean
} = {}) {
  let labels = options.labels ?? []
  let enabled = options.enabled ?? true
  const listeners = new Set<() => void>()
  const emit = () => { for (const l of [...listeners]) l() }
  const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
  const host: RelationUiHost = {
    document: (workspaceId) => documentStoreFor(workspaceId),
    subscribeDocuments: subscribeDocumentStores,
    savedLabels: { get: () => labels, set: (next) => { labels = next; emit() }, subscribe },
    relationsEnabled: () => ({ get: () => enabled, subscribe }),
    definitions: () => options.definitions ?? [],
    createPanel: options.createPanel ?? (() => null),
  }
  installRelationUiHost(host)
  return {
    labels: () => labels,
    setLabels: (next: string[]) => { labels = next; emit() },
    setEnabled: (next: boolean) => { enabled = next; emit() },
    uninstall: () => installRelationUiHost(null),
  }
}
