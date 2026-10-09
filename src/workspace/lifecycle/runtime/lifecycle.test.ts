import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isRpcError } from '@kernel/rpc/contract'
import { createTrustGate, workspaceCapabilityImpl, workspaceInfo } from './index'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-lifecycle-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe('trust gate', () => {
  it('starts untrusted and refuses with untrusted', () => {
    const gate = createTrustGate({ file: path.join(dir, 'trust.json') })
    expect(gate.isTrusted()).toBe(false)
    expect(gate.state()).toEqual({ trusted: false, decidedAt: null })
    try {
      gate.requireTrusted()
      expect.unreachable()
    } catch (err) {
      expect(isRpcError(err, 'untrusted')).toBe(true)
    }
    gate.dispose()
  })

  it('persists a decision and notifies on change', async () => {
    const file = path.join(dir, 'trust.json')
    const gate = createTrustGate({ file, now: () => new Date('2026-01-02T03:04:05Z') })
    const seen: boolean[] = []
    gate.onChange((state) => seen.push(state.trusted))
    gate.set(true)
    gate.set(true)
    expect(seen).toEqual([true])
    expect(() => gate.requireTrusted()).not.toThrow()
    await gate.flush()
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ trusted: true, decidedAt: '2026-01-02T03:04:05.000Z' })
    gate.dispose()

    const reopened = createTrustGate({ file })
    expect(reopened.isTrusted()).toBe(true)
    reopened.dispose()
  })

  it('trusts on start for cate serve', () => {
    const gate = createTrustGate({ file: path.join(dir, 'trust.json'), trustOnStart: true })
    expect(gate.isTrusted()).toBe(true)
    gate.dispose()
  })

  it('serves the workspace capability', async () => {
    const gate = createTrustGate({ file: path.join(dir, 'trust.json') })
    const impl = workspaceCapabilityImpl({ trust: gate, info: workspaceInfo('rt1', '/home/me/proj') })
    const ctx = {} as never
    expect(await impl.info(undefined as never, ctx)).toEqual({ runtimeId: 'rt1', root: '/home/me/proj', name: 'proj' })
    const events: boolean[] = []
    const sink = { emit: (s: { trusted: boolean }) => events.push(s.trusted) } as never
    const stop = impl.watchTrust(undefined as never, sink, ctx) as () => void
    expect((await impl.setTrust({ trusted: true }, ctx)).trusted).toBe(true)
    expect((await impl.getTrust(undefined as never, ctx)).trusted).toBe(true)
    stop()
    expect(events).toEqual([false, true])
    gate.dispose()
  })
})
