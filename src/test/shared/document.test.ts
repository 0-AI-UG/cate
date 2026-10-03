// The shared document with two clients: concurrent edits, a client offline
// while the other works, and the runtime restarting under both.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RefusedOp } from '@client/document'
import { startSharedWorkspace, until, untilState, type SharedWorkspace, type TestClient } from '../sharedWorkspace'

let ws: SharedWorkspace

beforeEach(async () => { ws = await startSharedWorkspace() })
afterEach(async () => { await ws?.stop() })

const panel = (c: TestClient, id: string) => c.document.getSnapshot().panels[id]
const title = (c: TestClient, id: string) => panel(c, id)?.title
const synced = (c: TestClient) => until(() => (c.document.isSynced() && c.document.pending.length === 0 ? true : undefined), 5_000, `${c.name} synced`)

/** Both mirrors hold the same document once every op is confirmed. */
async function converged(): Promise<void> {
  await synced(ws.a)
  await synced(ws.b)
  await until(() => (ws.a.document.seq === ws.b.document.seq ? true : undefined), 5_000, 'same seq')
  expect(ws.b.document.getSnapshot()).toEqual(ws.a.document.getSnapshot())
}

describe.skipIf(process.platform === 'win32')('shared workspace: document', () => {
  it('concurrent renames of one panel converge on one title in both clients', async () => {
    const id = ws.a.createPanel('terminal')
    await until(() => panel(ws.b, id), 5_000, 'panel in B')
    for (let i = 0; i < 20; i++) {
      ws.a.document.propose({ kind: 'updatePanel', id, patch: { title: `a${i}` } })
      ws.b.document.propose({ kind: 'updatePanel', id, patch: { title: `b${i}` } })
    }
    await converged()
    expect(title(ws.a, id)).toMatch(/^[ab]19$/)
  })

  it('a client offline catches up with what the other did, and its own queued edits land', async () => {
    const kept = ws.a.createPanel('terminal')
    const dropped = ws.a.createPanel('terminal')
    await until(() => panel(ws.b, dropped), 5_000, 'panels in B')

    ws.b.offline()
    await untilState(ws.b, 'offline')
    const added = ws.a.createPanel('terminal')
    ws.a.document.propose({ kind: 'removePanels', ids: [dropped] })
    ws.b.document.propose({ kind: 'updatePanel', id: kept, patch: { title: 'renamed offline' } })
    expect(title(ws.b, kept)).toBe('renamed offline')
    await synced(ws.a)

    ws.b.online()
    await untilState(ws.b, 'connected')
    await converged()
    expect(panel(ws.b, added)).toBeDefined()
    expect(panel(ws.b, dropped)).toBeUndefined()
    expect(title(ws.a, kept)).toBe('renamed offline')
  })

  it('an offline edit of a panel the other client removed is refused, and both agree it is gone', async () => {
    const id = ws.a.createPanel('terminal')
    await until(() => panel(ws.b, id), 5_000, 'panel in B')
    const refused: RefusedOp[] = []
    ws.b.document.onRefused((r) => refused.push(r))

    ws.b.offline()
    await untilState(ws.b, 'offline')
    ws.a.document.propose({ kind: 'removePanels', ids: [id] })
    ws.b.document.propose({ kind: 'updatePanel', id, patch: { title: 'too late' } })
    await synced(ws.a)

    ws.b.online()
    await converged()
    expect(panel(ws.b, id)).toBeUndefined()
    expect(refused.map((r) => r.op.kind)).toEqual(['updatePanel'])
  })

  it('undo in A reverts only A\'s own edit, not B\'s later one', async () => {
    const mine = ws.a.createPanel('terminal')
    const theirs = ws.a.createPanel('terminal')
    await until(() => panel(ws.b, theirs), 5_000, 'panels in B')
    ws.a.document.propose({ kind: 'updatePanel', id: mine, patch: { title: 'by A' } })
    await synced(ws.a)
    ws.b.document.propose({ kind: 'updatePanel', id: theirs, patch: { title: 'by B' } })
    await converged()

    expect(ws.a.document.undo()).toBe(true)
    await converged()
    expect(title(ws.b, mine)).not.toBe('by A')
    expect(title(ws.a, theirs)).toBe('by B')
  })

  it('a runtime restart keeps the document, and both clients reconnect to it', async () => {
    const id = ws.b.createPanel('terminal')
    ws.b.document.propose({ kind: 'updatePanel', id, patch: { title: 'survives' } })
    await converged()

    await ws.restartRuntime()
    await untilState(ws.a, 'connected', 15_000)
    await untilState(ws.b, 'connected', 15_000)
    ws.a.document.propose({ kind: 'updatePanel', id, patch: { title: 'after restart' } })
    await converged()
    expect(title(ws.b, id)).toBe('after restart')
  })

  it('a third client joining late gets the whole document', async () => {
    const id = ws.a.createPanel('terminal')
    ws.b.document.propose({ kind: 'updatePanel', id, patch: { title: 'before C' } })
    await converged()
    const c = await ws.join('C', 'network')
    await synced(c)
    expect(c.document.getSnapshot()).toEqual(ws.a.document.getSnapshot())
  })
})
