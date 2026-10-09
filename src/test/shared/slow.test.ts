// Two clients over slow links: the document, sessions and undo behave as on
// a fast one, only later. B is slow (80 ms plus up to 40 ms jitter) unless a
// test slows A too.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RefusedOp } from '@client/document'
import type { TerminalSnapshot } from '@panels/terminal/contract'
import { startSharedWorkspace, until, untilState, type SharedWorkspace, type TestClient } from '../sharedWorkspace'

let ws: SharedWorkspace

const SLOW = { latencyMs: 80, jitterMs: 40 }

beforeEach(async () => {
  ws = await startSharedWorkspace()
  ws.b.slow(SLOW)
})
afterEach(async () => { await ws?.stop() })

const panel = (c: TestClient, id: string) => c.document.getSnapshot().panels[id]
const title = (c: TestClient, id: string) => panel(c, id)?.title
const synced = (c: TestClient) => until(() => (c.document.isSynced() && c.document.pending.length === 0 ? true : undefined), 15_000, `${c.name} synced`)

async function converged(): Promise<void> {
  await synced(ws.a)
  await synced(ws.b)
  await until(() => (ws.a.document.seq === ws.b.document.seq ? true : undefined), 15_000, 'same seq')
  expect(ws.b.document.getSnapshot()).toEqual(ws.a.document.getSnapshot())
}

describe.skipIf(process.platform === 'win32')('shared workspace: slow links', () => {
  for (const both of [false, true]) {
    it(`concurrent renames converge${both ? ' with both clients slow' : ''}`, async () => {
      if (both) ws.a.slow(SLOW)
      const id = ws.a.createPanel('terminal')
      await until(() => panel(ws.b, id), 10_000, 'panel in B')
      for (let i = 0; i < 15; i++) {
        ws.a.document.propose({ kind: 'updatePanel', id, patch: { title: `a${i}` } })
        ws.b.document.propose({ kind: 'updatePanel', id, patch: { title: `b${i}` } })
        await new Promise((r) => setTimeout(r, 10))
      }
      await converged()
      expect(title(ws.a, id)).toMatch(/^[ab]14$/)
    }, 30_000)
  }

  it('a slow client offline catches up on reconnect; its queued edit lands and a stale one is refused', async () => {
    const kept = ws.a.createPanel('terminal')
    const dropped = ws.a.createPanel('terminal')
    await until(() => panel(ws.b, dropped), 10_000, 'panels in B')
    const refused: RefusedOp[] = []
    ws.b.document.onRefused((r) => refused.push(r))

    ws.b.offline()
    await untilState(ws.b, 'offline')
    ws.a.document.propose({ kind: 'removePanels', ids: [dropped] })
    ws.b.document.propose({ kind: 'updatePanel', id: kept, patch: { title: 'slow offline' } })
    ws.b.document.propose({ kind: 'updatePanel', id: dropped, patch: { title: 'too late' } })
    await synced(ws.a)

    ws.b.online()
    await untilState(ws.b, 'connected', 15_000)
    await converged()
    expect(title(ws.a, kept)).toBe('slow offline')
    expect(panel(ws.b, dropped)).toBeUndefined()
    expect(refused.map((r) => r.op.kind)).toEqual(['updatePanel'])
  }, 30_000)

  it('a terminal round trip from the slow client shows on the screen the fast one reads', async () => {
    const id = ws.a.createPanel('terminal')
    await ws.b.session<TerminalSnapshot>(id).until((s) => s.status === 'running', 15_000)
    await ws.b.connection.runtime.api.call({ method: 'cate.terminal.type', args: { panelId: id, text: 'echo slow-$((20+22))\r' } })
    await until(async () => {
      const read = await ws.a.connection.runtime.api.call({ method: 'cate.terminal.read', args: { panelId: id } }) as { text: string }
      return read.text.includes('slow-42') ? true : undefined
    }, 15_000, 'output in A')
  }, 30_000)

  it('a surface replaced by a review: the slow client\'s channel moves to the review', async () => {
    const id = ws.a.createPanel('surface')
    const b = ws.b.session<Record<string, unknown>>(id)
    await b.until(() => true, 10_000)
    const record = ws.a.document.getSnapshot().panels[id]!
    ws.a.document.propose({ kind: 'replacePanel', record: { ...record, type: 'review', title: 'Diff Review', fields: {} } })
    const s = await b.until((s) => 'review' in s && 'comparison' in s && !(s as { loading?: boolean }).loading, 15_000)
    expect(s).toMatchObject({ error: null })
  }, 30_000)

  it('undo in the slow client reverts only its own edit', async () => {
    const mine = ws.a.createPanel('terminal')
    const theirs = ws.a.createPanel('terminal')
    await until(() => panel(ws.b, theirs), 10_000, 'panels in B')
    ws.b.document.propose({ kind: 'updatePanel', id: mine, patch: { title: 'by B' } })
    await synced(ws.b)
    ws.a.document.propose({ kind: 'updatePanel', id: theirs, patch: { title: 'by A' } })
    await converged()

    expect(ws.b.document.undo()).toBe(true)
    await converged()
    expect(title(ws.a, mine)).not.toBe('by B')
    expect(title(ws.b, theirs)).toBe('by A')
  }, 30_000)
})
