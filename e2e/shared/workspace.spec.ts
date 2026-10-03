// Shared workspace, the workspace itself: settings, files, search, trust,
// presence and the `cate` CLI are served by the one runtime, so both clients
// read and change the same state. Over the network, B drops and rejoins when
// A turns network access off and on, and a revoked device is refused.

import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { runInTerminal, cate } from '../fixtures/cate-terminal'
import { call, callError, describeShared, doc, propose, seedShared, snapshot, type SharedClient } from '../fixtures/shared-workspace'

type Settings = Record<string, unknown>
type Presence = { clients: { clientId: string; focused: string | null; viewing: string[] }[] }
const settings = (c: SharedClient) => call<Settings>(c, 'settings', 'getAll')
const presence = (c: SharedClient) => c.page.evaluate((ws) => window.__cateE2E!.presence(ws), c.workspaceId) as Promise<Presence>
const clientId = (c: SharedClient) => c.page.evaluate(() => window.__cateE2E!.clientId())
const connection = (c: SharedClient) => c.page.evaluate((ws) => window.__cateE2E!.connection(ws), c.workspaceId)

describeShared('workspace', (pair) => {
  test('a workspace setting changed in B is the setting for A; invalid values are refused', async () => {
    const { a, b } = pair()
    await call(b, 'settings', 'set', { key: 'terminalScrollback', value: 4321 })
    await expect.poll(async () => (await settings(a)).terminalScrollback).toBe(4321)
    await call(a, 'settings', 'set', { key: 'browserSearchEngine', value: 'duckDuckGo' })
    await expect.poll(async () => (await settings(b)).browserSearchEngine).toBe('duckDuckGo')
    expect(await callError(b, 'settings', 'set', { key: 'terminalScrollback', value: 'lots' })).toBe('rejected')
    expect(await callError(b, 'settings', 'set', { key: 'noSuchSetting', value: 1 })).toBe('rejected')
  })

  test('both clients see each other in presence, with what they focus', async () => {
    const { a, b } = pair()
    const [idA, idB] = [await clientId(a), await clientId(b)]
    await expect.poll(async () => (await presence(a)).clients.map((c) => c.clientId).sort()).toEqual([idA, idB].sort())
    const { panelId } = await seedShared(pair(), a, 'terminal', { x: 100, y: 100 })
    await call(b, 'presence', 'report', { focused: panelId, viewing: [panelId] })
    await expect.poll(async () => (await presence(a)).clients.find((c) => c.clientId === idB)?.focused).toBe(panelId)
    const info = await call<{ clients: { clientId: string }[] }>(a, 'runtime', 'info')
    expect(info.clients.map((c) => c.clientId)).toEqual(expect.arrayContaining([idA, idB]))
  })

  test('files written by one client are read by the other; stale writes conflict', async () => {
    const { a, b, project } = pair()
    const file = path.join(project, 'shared.txt')
    const written = await call<{ hash: string }>(a, 'file', 'write', { path: file, content: 'v1', baseHash: null })
    const read = await call<{ content?: string; text?: string; hash: string }>(b, 'file', 'read', { path: file })
    expect(read.content ?? read.text).toBe('v1')
    expect(read.hash).toBe(written.hash)

    await call(b, 'file', 'write', { path: file, content: 'v2 from B', baseHash: written.hash })
    expect(readFileSync(file, 'utf8')).toBe('v2 from B')
    // A still holds v1's hash: its write is stale.
    expect(await callError(a, 'file', 'write', { path: file, content: 'v2 from A', baseHash: written.hash })).toBe('conflict')
    expect(readFileSync(file, 'utf8')).toBe('v2 from B')

    await call(a, 'file', 'mkdir', { path: path.join(project, 'dir') })
    await call(b, 'file', 'rename', { from: file, to: path.join(project, 'dir', 'moved.txt') })
    const listing = JSON.stringify(await call(a, 'file', 'readDir', { path: path.join(project, 'dir') }))
    expect(listing).toContain('moved.txt')
    await call(a, 'file', 'remove', { path: path.join(project, 'dir', 'moved.txt') })
    expect(JSON.stringify(await call(b, 'file', 'readDir', { path: path.join(project, 'dir') }))).not.toContain('moved.txt')
  })

  test('file search runs on the runtime for either client', async () => {
    const { a, b, project } = pair()
    writeFileSync(path.join(project, 'needle-haystack.ts'), 'export const needle = 1\n')
    for (const c of [a, b]) {
      await expect.poll(async () => JSON.stringify(await call(c, 'search', 'files', { query: 'needle', maxResults: 10 })), { timeout: 20_000 })
        .toContain('needle-haystack.ts')
    }
  })

  test('the git repository is the runtime\'s, whichever client asks', async () => {
    const { a, b } = pair()
    const info = await call<{ root: string }>(b, 'workspace', 'info')
    expect(info.root).toBe(pair().project)
    expect(await call(b, 'vcs', 'isRepo', {})).toBe(true)
    const branches = JSON.stringify(await call(a, 'vcs', 'branchList', {}))
    expect(branches).toContain('trunk')
  })

  test('trust is one decision for every client', async () => {
    const { a, b } = pair()
    await call(b, 'workspace', 'setTrust', { trusted: false })
    await expect.poll(async () => (await call<{ trusted: boolean }>(a, 'workspace', 'getTrust')).trusted).toBe(false)
    expect(await callError(a, 'vcs', 'readStatus', {})).toBe('untrusted')
    await call(a, 'workspace', 'setTrust', { trusted: true })
    await expect.poll(async () => (await call<{ trusted: boolean }>(b, 'workspace', 'getTrust')).trusted).toBe(true)
    await expect.poll(() => callError(b, 'vcs', 'readStatus', {})).toBe('ok')
  })

  test('the cate CLI in a terminal B made drives the workspace A sees', async () => {
    const { a, b, project } = pair()
    writeFileSync(path.join(project, 'cli-target.ts'), 'export const cli = true\n')
    const { panelId } = await seedShared(pair(), b, 'terminal', { x: 900, y: 100 })
    await expect.poll(async () => (await snapshot<{ status: string }>(b, panelId))?.status, { timeout: 20_000 }).toBe('running')
    const run = async (...args: string[]) => {
      const result = await runInTerminal(b.page, panelId, cate(...args), 30_000)
      expect(result.code, `${args.join(' ')}\n${result.output}`).toBe(0)
      return result.output
    }
    expect(await run('panel', 'list')).toContain('terminal')

    const before = new Set(Object.keys((await doc(a))!.panels))
    await run('editor', 'open', path.join(project, 'cli-target.ts'))
    await expect.poll(async () => Object.values((await doc(a))!.panels)
      .filter((p) => !before.has(p.id) && p.type === 'editor').map((p) => p.fields.filePath)).toEqual([path.join(project, 'cli-target.ts')])

    await run('panel', 'title', 'Titled by CLI', '--panel', panelId)
    await expect.poll(async () => (await doc(a))?.panels[panelId]?.title).toBe('Titled by CLI')
    await run('notify', 'hello from the shared runtime')

    // The CLI permission is a workspace setting: turned off from A, B's CLI is refused.
    await call(a, 'settings', 'set', { key: 'cliPanelReadEnabled', value: false })
    expect((await runInTerminal(b.page, panelId, cate('panel', 'list'), 30_000)).code).not.toBe(0)
    await call(a, 'settings', 'set', { key: 'cliPanelReadEnabled', value: true })
  })

  test('network only: B drops when A turns network access off, and catches up after', async () => {
    const { a, b, transport } = pair()
    test.skip(transport !== 'network', 'the local socket is not affected by network access')
    await call(a, 'settings', 'set', { key: 'runtimeNetwork', value: 'off' })
    await expect.poll(async () => (await connection(b))?.state, { timeout: 20_000 }).not.toBe('connected')

    // Work done while B is away.
    const { panelId } = (await a.page.evaluate(() => window.__cateE2E!.createOnCanvas('terminal', { x: 1700, y: 100 })))!
    await call(a, 'settings', 'set', { key: 'runtimeNetwork', value: 'sameNetwork' })
    await expect.poll(async () => (await connection(b))?.state, { timeout: 60_000 }).toBe('connected')
    await expect.poll(async () => !!(await doc(b))?.panels[panelId], { timeout: 20_000 }).toBe(true)

    // And B's changes after reconnecting reach A.
    await propose(b, { kind: 'updatePanel', id: panelId, patch: { title: 'After reconnect' } })
    await expect.poll(async () => (await doc(a))?.panels[panelId]?.title).toBe('After reconnect')
  })

  test('network only: a revoked device is cut off', async () => {
    const { a, b, transport } = pair()
    test.skip(transport !== 'network', 'local clients are not paired devices')
    const devices = await call<{ publicKey: string }[]>(a, 'pairing', 'list')
    expect(devices).toHaveLength(1)
    await call(a, 'pairing', 'revoke', { deviceKey: devices[0]!.publicKey })
    expect(await call(a, 'pairing', 'list')).toEqual([])
    await expect.poll(async () => (await connection(b))?.state, { timeout: 30_000 }).not.toBe('connected')
    // It stays out: its retries fail the handshake.
    await b.page.waitForTimeout(3_000)
    expect((await connection(b))?.state).not.toBe('connected')
  })

  test('network only: a revoked device is told it was refused', async () => {
    const { b, transport } = pair()
    test.skip(transport !== 'network', 'local clients are not paired devices')
    await expect.poll(async () => (await connection(b))?.state, { timeout: 20_000 }).toBe('refused')
  })
})
