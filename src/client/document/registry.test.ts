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
import { RUNTIME_CAPABILITIES } from '@panels/capabilities'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { loadWorkspaceViews } from './workspaceViews'
import { createLifecycleBus } from '@kernel/lifecycle/contract'

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
    const server = new RpcServer({ lifecycle: createLifecycleBus(), version: 'test' })
    const documentImpl: CapabilityImpl<typeof documentCapability> = {
      apply: ({ op }) => {
        const result = sequencer.submit(op)
        if (result.status === 'failed') throw new RpcError(result.error.code, result.error.message)
        return result
      },
      subscribe: (_params, sink) => { sink.emit({ kind: 'doc', seq: sequencer.seq, epoch: sequencer.epoch, startSeq: 0, doc: sequencer.doc }) },
    }
    server.register(documentCapability, documentImpl)
    server.register(presenceCapability, {
      report: (report) => { reports.push(report) },
      subscribe: () => {},
    })
    const connections = new WorkspaceConnections({
      capabilities: RUNTIME_CAPABILITIES,
      identity: createClientIdentity({ device: { name: 'd', publicKey: 'FP' }, features: [] }),
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
    const device = createMemoryDeviceStore({ 'workspace-views': { ws: { c1: { x: -50, y: 70, zoom: 0.8 } } } })
    const views = await loadWorkspaceViews(device)
    cleanup.push(() => views.dispose())
    const detach = attachDocuments(connections, views)
    cleanup.push(detach, () => connections.dispose())

    connections.open('ws', { kind: 'local', root: '/w' })
    const store = documentStoreFor('ws')!
    const state = clientStateFor('ws')!
    expect(state.getSnapshot().viewports.c1).toEqual({ x: -50, y: 70, zoom: 0.8 })
    await store.ready
    store.propose({
      kind: 'addPanel',
      record: { id: 'p1', type: 'terminal', title: 't', fields: {} },
      at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' },
    })
    await vi.waitFor(() => expect(sequencer.seq).toBe(1))
    state.focus('p1')
    await vi.waitFor(() => expect(reports.at(-1)).toEqual({ viewing: [], focused: 'p1', attentive: true }))

    state.setViewport('c1', { x: 123, y: -456, zoom: 1.2 })
    connections.close('ws')
    expect(documentStoreFor('ws')).toBeNull()
    expect(clientStateFor('ws')).toBeNull()
    connections.open('ws', { kind: 'local', root: '/w' })
    expect(clientStateFor('ws')!.getSnapshot().viewports.c1).toEqual({ x: 123, y: -456, zoom: 1.2 })
    expect(await device.get('workspace-views')).toEqual({ ws: { c1: { x: 123, y: -456, zoom: 1.2 } } })
  })
})
