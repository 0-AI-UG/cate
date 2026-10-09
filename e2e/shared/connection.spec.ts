// Shared workspace: both clients connect to one runtime and see each other.

import { expect } from '@playwright/test'
import { describeShared } from '../fixtures/shared-workspace'
import { test } from '@playwright/test'

describeShared('connection', (pair) => {
  test('both clients are connected to the same runtime', async () => {
    const { a, b, transport } = pair()
    expect(await a.page.evaluate((ws) => window.__cateE2E!.connection(ws), a.workspaceId)).toEqual({ kind: 'local', state: 'connected' })
    expect(await b.page.evaluate((ws) => window.__cateE2E!.connection(ws), b.workspaceId)).toEqual({ kind: transport, state: 'connected' })
  })
})
