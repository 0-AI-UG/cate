// The transport decides who is admitted, never how the runtime serves a
// client (architecture 7.5): the same scenario over the local socket, a
// machine's bridge and the network gives the same result, and the runtime
// sees the same kind of client.

import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startSharedWorkspace, until, untilState, type SharedWorkspace, type TestClient } from '../sharedWorkspace'

let ws: SharedWorkspace

beforeEach(async () => { ws = await startSharedWorkspace({ files: { 'notes.md': 'base\n' } }) })
afterEach(async () => { await ws?.stop() })

const panelIn = (c: TestClient, id: string) => until(() => c.document.getSnapshot().panels[id], 5_000, `panel in ${c.name}`)

/** One client's scenario; what it saw, for comparing across transports. */
async function scenario(c: TestClient): Promise<unknown> {
  // The document both ways.
  const fromA = ws.a.createPanel('terminal')
  await panelIn(c, fromA)
  const fromC = c.createPanel('terminal')
  await panelIn(ws.a, fromC)

  // A shared buffer both ways.
  const file = path.join(ws.root, 'notes.md')
  const editor = ws.a.createPanel('editor', { filePath: file })
  await panelIn(c, editor)
  const mine = c.buffer(file)
  const theirs = ws.a.buffer(file)
  await Promise.all([mine.attached.ready, theirs.attached.ready])
  mine.text.insert(mine.text.length, `${c.name}\n`)
  await until(() => (theirs.text.toString().includes(`${c.name}\n`) ? true : undefined), 5_000, 'edit reaches A')

  // A dropped link comes back and catches up.
  c.offline()
  await untilState(c, 'offline')
  const whileAway = ws.a.createPanel('terminal')
  c.online()
  await untilState(c, 'connected')
  await panelIn(c, whileAway)

  // How the runtime sees the client: the same shape whatever the transport.
  const status = await ws.a.connection.runtime.runtime.info()
  const seen = status.clients.find((client) => client.clientId === c.connection.clientId)
  return { keys: Object.keys(seen ?? {}).sort(), features: seen?.features }
}

describe.skipIf(process.platform === 'win32')('shared workspace: transports', () => {
  it('serves a client the same over the local socket, a machine bridge and the network', async () => {
    const seen: Record<string, unknown> = {}
    for (const transport of ['local', 'machine', 'network'] as const) {
      const c = await ws.join(`via-${transport}`, transport, ['canvas'])
      expect(c.connection.target.kind).toBe(transport)
      seen[transport] = await scenario(c)
      c.close()
    }
    expect(seen.machine).toEqual(seen.local)
    expect(seen.network).toEqual(seen.local)
    expect(seen.local).toEqual({ keys: ['clientId', 'device', 'features'], features: ['canvas'] })
  })

  it('records every client as a device of the workspace, and removing one drops it on any transport', async () => {
    const pairing = ws.a.connection.runtime.pairing
    const admittedBy = { local: 'machineUser', machine: 'machineUser', network: 'pairing' } as const
    for (const transport of ['local', 'machine', 'network'] as const) {
      const c = await ws.join(`via-${transport}`, transport, ['canvas'])
      await untilState(c, 'connected')
      const key = c.connection.identity.device.publicKey
      const device = await until(async () => (await pairing.list()).find((d) => d.publicKey === key), 5_000, `${transport} device listed`)
      expect(device).toMatchObject({ name: `via-${transport}`, admittedBy: admittedBy[transport] })

      await pairing.revoke({ deviceKey: key })
      if (transport === 'network') {
        // A paired device is locked out until it pairs again.
        await untilState(c, 'refused')
      } else {
        // A user of the machine is let in again, and is a device again.
        await until(async () => (await pairing.list()).find((d) => d.publicKey === key), 5_000, `${transport} device back`)
      }
      c.close()
    }
  })
})
