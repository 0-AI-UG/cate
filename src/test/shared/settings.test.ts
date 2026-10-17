// Workspace settings with two clients: one value for everyone, invalid values
// refused, changes pushed to subscribers, and the CLI gates following the
// settings for terminals whichever client made them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiCapability } from '@kernel/api/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { framePortOver, type ChannelEvent } from '@kernel/rpc/contract'
import { workspaceSettingsTable, type WorkspaceSettings } from '@panels/settings'
import { createWorkspaceSettingsMirror } from '@kernel/settings/client'
import type { TerminalSnapshot } from '@panels/terminal/contract'
import { dialLocal } from '@runtime/transports/node'
import { startSharedWorkspace, until, untilState, type SharedWorkspace, type TestClient } from '../sharedWorkspace'

let ws: SharedWorkspace
const callers: RpcClient[] = []

beforeEach(async () => { ws = await startSharedWorkspace() })
afterEach(async () => {
  for (const c of callers.splice(0)) c.close()
  await ws?.stop()
})

const settings = (c: TestClient) => c.connection.runtime.settings
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error')

/** The `cate` API as the CLI in a terminal of `c` reaches it (its CATE_TOKEN). */
async function cliIn(c: TestClient) {
  const id = c.createPanel('terminal')
  await c.session<TerminalSnapshot>(id).until((s) => s.status === 'running')
  const api = c.connection.runtime.api
  await api.call({ method: 'cate.terminal.type', args: { panelId: id, text: `printf '%s%s\\n' TOK= "$CATE_TOKEN"` } })
  await api.call({ method: 'cate.terminal.press', args: { panelId: id, keys: 'enter' } })
  const token = await until(async () => {
    const read = await api.call({ method: 'cate.terminal.read', args: { panelId: id } }) as { text: string }
    return /TOK=([A-Za-z0-9_-]{20,})/.exec(read.text)?.[1]
  }, 10_000, 'CATE_TOKEN')
  const rpc = new RpcClient({ version: 'test', identity: { caller: { token } } })
  callers.push(rpc)
  await rpc.attach(framePortOver(await dialLocal(ws.daemon.endpoint), 'stream'))
  return { panelId: id, cli: createCapabilityProxy(rpc, apiCapability) }
}

describe.skipIf(process.platform === 'win32')('shared workspace: settings', () => {
  it('a client\'s settings mirror keeps following after its connection drops', async () => {
    const mirror = createWorkspaceSettingsMirror(settings(ws.a), workspaceSettingsTable)
    await mirror.ready
    ws.a.offline()
    await untilState(ws.a, 'offline')
    ws.a.online()
    await untilState(ws.a, 'connected')
    const expected = !mirror.get('cliNotifyEnabled')
    await settings(ws.b).set({ key: 'cliNotifyEnabled', value: expected })
    await until(() => (mirror.get('cliNotifyEnabled') === expected ? true : undefined), 5_000, 'A sees the change')
    mirror.dispose()
  })

  it('a setting B changes is A\'s, pushed to A\'s subscription; invalid values are refused', async () => {
    const changes: Partial<WorkspaceSettings>[] = []
    const sub = settings(ws.a).subscribe()
    sub.onEvent((event) => {
      const e = event as ChannelEvent<WorkspaceSettings, Partial<WorkspaceSettings>>
      if (e.kind === 'change') changes.push(e.change)
    })
    await new Promise((r) => setTimeout(r, 50))

    await settings(ws.b).set({ key: 'cliNotifyEnabled', value: false })
    expect((await settings(ws.a).getAll()).cliNotifyEnabled).toBe(false)
    await until(() => (changes.some((c) => c.cliNotifyEnabled === false) ? true : undefined), 5_000, 'change pushed to A')

    expect(await code(settings(ws.b).set({ key: 'cliNotifyEnabled', value: 'yes' as never }))).toBe('rejected')
    expect(await code(settings(ws.a).set({ key: 'noSuchSetting' as never, value: true as never }))).toBe('rejected')
    expect((await settings(ws.a).getAll()).cliNotifyEnabled).toBe(false)
    sub.cancel()
  })

  it('concurrent sets from both clients end on one value for both', async () => {
    ws.b.slow({ latencyMs: 60, jitterMs: 40 })
    await Promise.all(Array.from({ length: 10 }, (_, i) => [
      settings(ws.a).set({ key: 'cliNotifyEnabled', value: i % 2 === 0 }),
      settings(ws.b).set({ key: 'cliNotifyEnabled', value: i % 2 === 1 }),
    ]).flat())
    const [a, b] = await Promise.all([settings(ws.a).getAll(), settings(ws.b).getAll()])
    expect(a.cliNotifyEnabled).toBe(b.cliNotifyEnabled)
  }, 20_000)

  for (const terminalOf of ['a', 'b'] as const) {
    it(`the CLI gates follow the settings for a terminal ${terminalOf.toUpperCase()} made`, async () => {
      const { cli } = await cliIn(ws[terminalOf])
      const other = terminalOf === 'a' ? ws.b : ws.a
      await expect(cli.call({ method: 'cate.panel.list' })).resolves.toBeInstanceOf(Array)

      await settings(other).set({ key: 'cliPanelReadEnabled', value: false })
      expect(await code(cli.call({ method: 'cate.panel.list' }))).not.toBe('ok')
      await settings(other).set({ key: 'cliPanelReadEnabled', value: true })
      await expect(cli.call({ method: 'cate.panel.list' })).resolves.toBeInstanceOf(Array)

      await settings(other).set({ key: 'cliEnabled', value: false })
      expect(await code(cli.call({ method: 'cate.panel.list' }))).not.toBe('ok')
      await settings(other).set({ key: 'cliEnabled', value: true })
      await expect(cli.call({ method: 'cate.panel.list' })).resolves.toBeInstanceOf(Array)
    }, 30_000)
  }
})
