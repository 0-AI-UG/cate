// Two clients, one runtime: A on the local socket, B paired over the network.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startSharedWorkspace, until, untilState, type SharedWorkspace } from '../sharedWorkspace'

let ws: SharedWorkspace

beforeEach(async () => { ws = await startSharedWorkspace() })
afterEach(async () => { await ws?.stop() })

describe.skipIf(process.platform === 'win32')('shared workspace: connection', () => {
  it('both clients reach the same runtime and see each other', async () => {
    expect(ws.a.connection.state.kind).toBe('connected')
    expect(ws.b.connection.state.kind).toBe('connected')
    const info = await ws.b.connection.runtime.runtime.info()
    expect(info.runtimeId).toBe(ws.daemon.runtimeId)
    expect(info.clients.map((c) => c.device.name).sort()).toEqual(['A', 'B'])
  })

  it('a panel created in A appears in B', async () => {
    const id = ws.a.createPanel('terminal')
    await until(() => ws.b.document.getSnapshot().panels[id], 5_000, 'panel in B')
    expect(ws.b.document.getSnapshot().panels[id]!.type).toBe('terminal')
  })
})

describe.skipIf(process.platform === 'win32')('shared workspace: stopping the runtime', () => {
  it('a deliberate stop leaves both clients stopped, even once the runtime is back, until each starts again', async () => {
    await ws.b.connection.runtime.runtime.stop()
    for (const c of [ws.a, ws.b]) await untilState(c, 'stopped')
    // Someone starts it again; neither client reconnects on its own.
    await ws.restartRuntime()
    await new Promise((r) => setTimeout(r, 500))
    expect([ws.a.connection.state.kind, ws.b.connection.state.kind]).toEqual(['stopped', 'stopped'])
    for (const c of [ws.a, ws.b]) {
      c.connection.retryNow()
      await untilState(c, 'connected')
    }
  })

  it('a runtime that goes away without a stop (a crash, an update) is reconnected to', async () => {
    await ws.restartRuntime()
    for (const c of [ws.a, ws.b]) await untilState(c, 'connected', 15_000)
  }, 30_000)
})
