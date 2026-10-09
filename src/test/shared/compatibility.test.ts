// Which clients a runtime serves: compatibility is the protocol major; a
// client of another build of the same protocol works normally.

import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL } from '@kernel/rpc/contract'
import { startSharedWorkspace, until, type SharedWorkspace } from '../sharedWorkspace'

let ws: SharedWorkspace | undefined
afterEach(async () => { await ws?.stop(); ws = undefined })

describe.skipIf(process.platform === 'win32')('shared workspace: compatibility', () => {
  it('a client of another build but the same protocol connects and works', async () => {
    ws = await startSharedWorkspace()
    const other = ws.connect('Other build', { build: 'test+another-build' })
    await other.document.ready
    expect(other.connection.state).toMatchObject({ kind: 'connected', stale: { app: 'test+another-build' } })
    const id = other.createPanel('terminal')
    await until(() => (ws!.a.document.getSnapshot().panels[id] ? true : undefined), 5_000, 'panel in A')
  })

  it('a client of another protocol major is incompatible', async () => {
    ws = await startSharedWorkspace()
    const other = ws.connect('Other protocol', { protocol: [PROTOCOL[0] + 1, 0] })
    await until(() => (other.connection.state.kind === 'incompatible' ? true : undefined), 5_000, 'incompatible')
  })
})
