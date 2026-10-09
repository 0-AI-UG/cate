// Shared workspace, relations made through the canvas UI: dragging a panel's
// connection handle onto empty canvas offers a new linked panel; the panel it
// creates must be a working one (a terminal runs its shell) for both clients.

import { test, expect } from '@playwright/test'
import type { Page } from 'playwright'
import { call, describeShared, doc, propose, seedShared, snapshot, terminalText, type SharedClient } from '../fixtures/shared-workspace'
import type { CanvasE2EHooks } from '../../src/shells/desktop/ui/app/e2e/e2eHarness'

/** Drags `nodeId`'s right connection handle `dx` px to the right and drops it on empty canvas. */
async function dragHandleToEmpty(page: Page, nodeId: string, dx: number): Promise<void> {
  // Handles show on the focused node, in a layer beside it.
  await page.locator(`[data-node-id="${nodeId}"] [data-tab-panel-id]`).first().click()
  const handle = page.locator(`[data-panel-connection-handles-for="${nodeId}"] [data-panel-connection-handle="right"]`)
  await expect(handle).toBeVisible({ timeout: 10_000 })
  const box = (await handle.boundingBox())!
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + dx, start.y + 20, { steps: 15 })
  await page.mouse.up()
}

const newTerminal = async (c: SharedClient, known: Set<string>) =>
  Object.values((await doc(c))?.panels ?? {}).find((p) => p.type === 'terminal' && !known.has(p.id))?.id

const SOURCES: { type: string; options?: Record<string, unknown> }[] = [
  { type: 'terminal' },
  { type: 'editor', options: { filePath: 'README.md' } },
  { type: 'browser', options: { url: 'about:blank' } },
  { type: 'review' },
  { type: 'chat' },
]

describeShared('relations', (pair) => {
  // Each case starts on an empty, unzoomed canvas: linking zooms to the new
  // panel, which would push the next source off screen.
  test.beforeEach(async () => {
    const p = pair()
    const ids = Object.values((await doc(p.a))!.panels).filter((r) => r.type !== 'canvas').map((r) => r.id)
    if (ids.length) await propose(p.a, { kind: 'removePanels', ids })
    for (const c of [p.a, p.b]) {
      await expect.poll(async () => Object.values((await doc(c))!.panels).filter((r) => r.type !== 'canvas').length).toBe(0)
      await c.page.evaluate(() => {
        const canvas = window.__cateE2E as unknown as CanvasE2EHooks
        canvas.resetViewport()
        canvas.setZoom(0.5)
      })
    }
  })

  async function linkNewTerminal(c: SharedClient, source: { panelId: string; nodeId: string }): Promise<string> {
    const known = new Set(Object.keys((await doc(c))!.panels))
    await dragHandleToEmpty(c.page, source.nodeId, 260)
    const menuItem = c.page.getByRole('menu', { name: 'New linked panel' }).getByRole('menuitem', { name: /Terminal/ }).first()
    await expect(menuItem).toBeVisible({ timeout: 10_000 })
    await menuItem.click()
    await expect.poll(() => newTerminal(c, known), { timeout: 15_000 }).toBeTruthy()
    const created = (await newTerminal(c, known))!
    await expect.poll(async () => Object.values((await doc(c))!.relations).some((r) => r.fromPanelId === source.panelId && r.toPanelId === created)).toBe(true)
    return created
  }
  async function expectShell(panelId: string): Promise<void> {
    for (const client of [pair().a, pair().b]) {
      await expect.poll(async () => {
        const s = await snapshot<{ status: string; error: string | null }>(client, panelId)
        return s && { status: s.status, error: s.error }
      }, { timeout: 20_000 }).toEqual({ status: 'running', error: null })
      await expect.poll(() => terminalText(client, panelId), { timeout: 20_000 }).toMatch(/\S/)
      // And the view shows it: attached to the PTY, not an empty frame.
      const nodeId = await client.page.evaluate((id) => (window.__cateE2E as unknown as CanvasE2EHooks).nodeForPanel(id), panelId)
      await expect(client.page.locator(`[data-node-id="${nodeId}"] .xterm-rows`)).toContainText(/\S/, { timeout: 20_000 })
    }
  }

  for (const creator of ['a', 'b'] as const) {
    for (const source of SOURCES) {
      test(`${creator.toUpperCase()} links a new terminal from a ${source.type}: it runs its shell for both`, async () => {
        const p = pair()
        const from = await seedShared(p, p.a, source.type, { x: 80, y: 80 }, source.options)
        await expectShell(await linkNewTerminal(p[creator], from))
      })
    }
  }

  test('a terminal linked from a panel in a worktree runs in that worktree', async () => {
    const p = pair()
    const worktree = await call<{ id: string; path: string }>(p.a, 'vcs', 'worktreeCreate', { branch: 'linked' })
    await expect.poll(async () => (await doc(p.b))?.worktrees[worktree.id]?.status, { timeout: 30_000 }).toBe('ready')
    const from = await seedShared(p, p.a, 'terminal', { x: 80, y: 80 }, { worktreeId: worktree.id })
    const created = await linkNewTerminal(p.b, from)
    await expectShell(created)
    expect((await snapshot<{ cwd: string | null }>(p.a, created))?.cwd).toBe(worktree.path)
  })
})
