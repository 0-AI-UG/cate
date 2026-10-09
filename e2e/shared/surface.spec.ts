// Shared workspace, surface panel: a placeholder that becomes the picked type
// in place (same id, same node). A pick in one client turns it for both.

import { test, expect } from '@playwright/test'
import { describeShared, doc, nodeOf, propose, seedShared, snapshot, type SharedClient } from '../fixtures/shared-workspace'

const typeOf = async (c: SharedClient, id: string) => (await doc(c))?.panels[id]?.type

describeShared('surface', (pair) => {
  test('a surface made in A shows its picker in B; B picks Diff Review through the UI', async () => {
    const { a, b } = pair()
    const { panelId, nodeId } = await seedShared(pair(), a, 'surface', { x: 80, y: 80 })
    const picker = b.page.locator(`[data-node-id="${nodeId}"] [role="group"][aria-label="Open a surface"]`)
    await expect(picker).toBeVisible({ timeout: 15_000 })
    // The first click focuses the node (its unfocused overlay takes it).
    const overlay = b.page.locator(`[data-node-id="${nodeId}"] [data-unfocused-overlay]`)
    if (await overlay.count()) await overlay.click()
    await picker.getByRole('button', { name: /Diff Review/ }).click()
    for (const c of [a, b]) await expect.poll(() => typeOf(c, panelId)).toBe('review')
    // Same node, now rendering the review.
    await expect.poll(async () => (await nodeOf(a, nodeId))?.panelId).toBe(panelId)
    await expect(a.page.locator(`[data-node-id="${nodeId}"] [role="group"][aria-label="Open a surface"]`)).toHaveCount(0)
    // And it works: the comparison loads, without an error, for both.
    for (const c of [a, b]) {
      await expect.poll(async () => {
        const s = await snapshot<{ comparison: unknown; error: string | null }>(c, panelId)
        return s && { loaded: s.comparison !== null, error: s.error }
      }, { timeout: 20_000 }).toEqual({ loaded: true, error: null })
      await expect(c.page.locator(`[data-node-id="${nodeId}"]`)).toContainText('No changes in this comparison', { timeout: 15_000 })
    }
  })

  test('a surface replaced by a terminal in B runs a shell A renders', async () => {
    const { a, b } = pair()
    const { panelId, nodeId } = await seedShared(pair(), a, 'surface', { x: 900, y: 80 })
    const record = (await doc(b))!.panels[panelId]!
    expect((await propose(b, { kind: 'replacePanel', record: { ...record, type: 'terminal', title: 'From surface', fields: {} } })).ok).toBe(true)
    await expect.poll(() => typeOf(a, panelId)).toBe('terminal')
    await a.page.waitForSelector(`[data-node-id="${nodeId}"] .xterm`, { timeout: 20_000 })
  })

  test('the runtime refuses a canvas replacing a surface on a canvas', async () => {
    const { a, b } = pair()
    const { panelId } = await seedShared(pair(), a, 'surface', { x: 80, y: 900 })
    const record = (await doc(b))!.panels[panelId]!
    await propose(b, { kind: 'replacePanel', record: { ...record, type: 'canvas', canvasId: crypto.randomUUID(), fields: {} } })
    // B's optimistic change is rolled back; A never sees it.
    await expect.poll(() => typeOf(b, panelId), { timeout: 15_000 }).toBe('surface')
    expect(await typeOf(a, panelId)).toBe('surface')
  })
})
