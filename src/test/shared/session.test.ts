// Panel sessions with two clients: one session behind both views, and a view
// that was offline resumes with the session as it is now.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TerminalSnapshot } from '@panels/terminal/contract'
import { startSharedWorkspace, until, untilState, type SharedWorkspace } from '../sharedWorkspace'

let ws: SharedWorkspace

beforeEach(async () => { ws = await startSharedWorkspace() })
afterEach(async () => { await ws?.stop() })

const screen = async (ws: SharedWorkspace, client: 'a' | 'b', panelId: string) =>
  ((await ws[client].connection.runtime.api.call({ method: 'cate.terminal.read', args: { panelId } })) as { text: string }).text

describe.skipIf(process.platform === 'win32')('shared workspace: sessions', () => {
  it('one PTY behind both clients; input from B shows on the screen A reads', async () => {
    const id = ws.a.createPanel('terminal')
    const a = await ws.a.session<TerminalSnapshot>(id).until((s) => s.status === 'running')
    const b = await ws.b.session<TerminalSnapshot>(id).until((s) => s.status === 'running')
    expect(b.ptyId).toBe(a.ptyId)

    await ws.b.session(id).send({ kind: 'submit', text: 'echo from-$((40+2))' })
    await until(async () => ((await screen(ws, 'a', id)).includes('from-42') ? true : undefined), 10_000, 'output in A')
  }, 30_000)

  it('a client offline while the PTY is terminated and restarted resumes on the new PTY', async () => {
    const id = ws.a.createPanel('terminal')
    const b = ws.b.session<TerminalSnapshot>(id)
    const first = await b.until((s) => s.status === 'running')

    ws.b.offline()
    await untilState(ws.b, 'offline')
    const a = ws.a.session<TerminalSnapshot>(id)
    await a.send({ kind: 'terminate' })
    await a.until((s) => s.status === 'exited')
    await a.send({ kind: 'restart', discard: true })
    const restarted = await a.until((s) => s.status === 'running' && s.ptyId !== first.ptyId)

    ws.b.online()
    const resumed = await b.until((s) => s.ptyId === restarted.ptyId && s.status === 'running')
    expect(resumed.exitCode).toBeNull()
  }, 30_000)

  it('a paired client reconnecting while the runtime restores finds the panels it had', async () => {
    const id = ws.a.createPanel('terminal')
    await ws.b.session<TerminalSnapshot>(id).until((s) => s.status === 'running')
    // B keeps asking for the panel's session while the new daemon listens
    // but has not restored the workspace yet.
    const restarting = ws.restartRuntime({ beforeStart: () => new Promise((resolve) => setTimeout(resolve, 2_000)) })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const resumed = ws.b.session<TerminalSnapshot>(id).until((s) => s.status === 'running', 20_000)
    await restarting
    await resumed
  }, 40_000)

  it('revoking trust ends every terminal', async () => {
    const id = ws.a.createPanel('terminal')
    await ws.b.session<TerminalSnapshot>(id).until((s) => s.status === 'running')
    await ws.a.connection.runtime.workspace.setTrust({ trusted: false })
    await ws.b.session<TerminalSnapshot>(id).until((s) => s.status === 'exited', 10_000)
    expect(ws.daemon.workspace.terminal.list().filter((t) => t.alive)).toEqual([])
  }, 20_000)

  it('a session survives a runtime restart for both clients', async () => {
    const id = ws.b.createPanel('terminal')
    await ws.b.session<TerminalSnapshot>(id).until((s) => s.status === 'running')
    await ws.restartRuntime()
    for (const c of [ws.a, ws.b]) {
      await untilState(c, 'connected', 15_000)
      await c.session<TerminalSnapshot>(id).until((s) => s.status === 'running', 15_000)
    }
  }, 30_000)
})

describe.skipIf(process.platform === 'win32')('shared workspace: replaced sessions', () => {
  it('a surface turned into a review: both clients\' open channels move to the review session', async () => {
    const id = ws.a.createPanel('surface')
    // Both clients show the surface, so both hold its channel open.
    const a = ws.a.session<Record<string, unknown>>(id)
    const b = ws.b.session<Record<string, unknown>>(id)
    await a.until(() => true)
    await b.until(() => true)

    const record = ws.b.document.getSnapshot().panels[id]!
    ws.b.document.propose({ kind: 'replacePanel', record: { ...record, type: 'review', title: 'Diff Review', fields: {} } })
    for (const probe of [a, b]) {
      const s = await probe.until((s) => 'review' in s && !(s as { loading?: boolean }).loading && 'comparison' in s)
      expect(s).toMatchObject({ error: null })
    }
  })
})
