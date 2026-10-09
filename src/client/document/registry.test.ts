import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcError, framePortOver, type ByteDuplex } from '@kernel/rpc/contract'
import { RpcServer, type CapabilityImpl } from '@kernel/rpc/runtime'
import {
  MAIN_WINDOW,
  createDocument,
  createSequencer,
  documentCapability,
  presenceCapability,
  type PresenceReport,
} from '@workspace/document/contract'
import { WorkspaceConnections, createClientIdentity } from '@client/connections'
import { attachDocuments, clientStateFor, documentStoreFor } from './registry'

function pipe(): [ByteDuplex, ByteDuplex] {
  const data: ((b: Uint8Array) => void)[] = [() => {}, () => {}]
  const closes: ((r?: string) => void)[] = []
  let finished = false
  const end = (self: 0 | 1): ByteDuplex => ({
    write: (bytes) => { const copy = bytes.slice(); queueMicrotask(() => { if (!finished) data[1 - self](copy) }) },
    onData: (listener) => { data[self] = listener },
    onClose: (listener) => { closes.push(listener) },
    close: (reason) => queueMicrotask(() => { if (finished) return; finished = true; for (const l of closes) l(reason) }),
  })
  return [end(0), end(1)]
}

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0)) fn() })

describe('attachDocuments', () => {
  it('gives each open connection a document mirror, client state and presence', async () => {
    const sequencer = createSequencer({ doc: createDocument() })
    const reports: PresenceReport[] = []
    const server = new RpcServer({ version: 'test' })
    const documentImpl: CapabilityImpl<typeof documentCapability> = {
      apply: ({ op }) => {
        const result = sequencer.submit(op)
        if (result.status === 'failed') throw new RpcError(result.error.code, result.error.message)
        return result
      },
      subscribe: (_params, sink) => { sink.emit({ kind: 'doc', seq: sequencer.seq, epoch: sequencer.epoch, doc: sequencer.doc }) },
    }
    server.register(documentCapability, documentImpl)
    server.register(presenceCapability, {
      report: (report) => { reports.push(report) },
      subscribe: () => {},
    })
    const connections = new WorkspaceConnections({
      identity: createClientIdentity({ device: { name: 'd', keyFingerprint: 'FP' }, features: [] }),
      version: 'test',
      transports: {
        dialLocal: async () => {
          const [client, runtime] = pipe()
          server.serve(framePortOver(runtime, 'stream'))
          return client
        },
        dialLoopbackTcp: () => new Promise(() => {}),
      },
    })
    const detach = attachDocuments(connections)
    cleanup.push(detach, () => connections.dispose())

    connections.open('ws', { kind: 'local', root: '/w' })
    const store = documentStoreFor('ws')!
    const state = clientStateFor('ws')!
    await store.ready
    store.propose({
      kind: 'addPanel',
      record: { id: 'p1', type: 'terminal', title: 't', fields: {} },
      at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' },
    })
    await vi.waitFor(() => expect(sequencer.seq).toBe(1))
    state.focus('p1')
    await vi.waitFor(() => expect(reports.at(-1)).toEqual({ viewing: [], focused: 'p1', attentive: true }))

    connections.close('ws')
    expect(documentStoreFor('ws')).toBeNull()
    expect(clientStateFor('ws')).toBeNull()
  })
})
