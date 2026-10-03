// Shared workspace, B restarting Cate. B restores the paired workspace on its
// own. When that runtime is unreachable, only the workspace is covered: the
// sidebar says what is wrong and the rest of the app stays usable. No dialog
// stands in front of the app.

import { test, expect } from '@playwright/test'
import { call, hasLan, launchSharedPair, relaunchB, type SharedPair } from '../fixtures/shared-workspace'

test.describe('startup with a paired workspace [network]', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(!hasLan, 'no LAN address on this host')
  let pair: SharedPair | undefined
  test.beforeAll(async () => {
    test.setTimeout(120_000)
    pair = await launchSharedPair('network')
  })
  test.afterAll(async () => { await pair?.close() })

  const row = (p: SharedPair) => p.b.page.locator(`[data-workspace-id="${p.b.workspaceId}"]`)

  test('B restarts and is back in the paired workspace', async () => {
    const p = pair!
    await relaunchB(p)
    await expect.poll(() => p.b.page.evaluate(() => window.__cateE2E!.selectedWorkspaceId()), { timeout: 30_000 }).toBe(p.b.workspaceId)
    await expect.poll(() => p.b.page.evaluate((ws) => window.__cateE2E!.connection(ws)?.state, p.b.workspaceId), { timeout: 30_000 }).toBe('connected')
    await expect(p.b.page.locator('[data-connection-blocker]')).toHaveCount(0)
  })

  test('with the runtime unreachable, B covers only the workspace and notes it in the sidebar', async () => {
    const p = pair!
    await relaunchB(p, () => call(p.a, 'settings', 'set', { key: 'runtimeNetwork', value: 'off' }).then(() => {}))
    const page = p.b.page
    await expect(page.locator('[data-connection-blocker]')).toBeVisible({ timeout: 30_000 })
    await expect(row(p).locator('[data-connection-status]')).toHaveAttribute('aria-label', /Not reachable|Offline/)
    // Nothing in front of the app: no dialog, the sidebar is not inert and takes clicks.
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await expect(page.locator('[data-app-sidebar] [inert]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Join a Workspace' }).first().click()
    await expect(page.locator('[role="dialog"]')).toHaveCount(1)
    await page.keyboard.press('Escape')
  })

  test('once the runtime is reachable again, B connects and the note goes', async () => {
    const p = pair!
    await call(p.a, 'settings', 'set', { key: 'runtimeNetwork', value: 'sameNetwork' })
    await expect(p.b.page.locator('[data-connection-blocker]')).toHaveCount(0, { timeout: 60_000 })
    await expect(row(p).locator('[data-connection-status]')).toHaveCount(0)
  })
})
