// Trust through the client core: the question every shell shows, and the
// answer that applies for every client of the workspace.

import { afterEach, describe, expect, it } from 'vitest'
import { createTrustStore } from '@client/workspaces'
import { startSharedWorkspace, type SharedWorkspace } from '../sharedWorkspace'

let ws: SharedWorkspace | undefined
afterEach(async () => { await ws?.stop(); ws = undefined })

describe.skipIf(process.platform === 'win32')('shared workspace: trust', () => {
  it('a client asks, the person trusts, and the runtime trusts the workspace for everyone', async () => {
    ws = await startSharedWorkspace({ trusted: false })
    const store = createTrustStore(() => ws!.b.connection.runtime.workspace)
    const kept = store.ensureTrusted(ws.b.workspaceId, 'shared')
    await new Promise((r) => setTimeout(r, 50))
    expect(store.current()).toMatchObject({ workspaceId: ws.b.workspaceId, label: 'shared' })
    await store.answer(true)
    await expect(kept).resolves.toBe(true)
    expect(store.current()).toBeNull()
    expect((await ws.a.connection.runtime.workspace.getTrust()).trusted).toBe(true)
  })
})
