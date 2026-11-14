// Shared workspace, review panel: one review session over the runtime's
// recorded agent edits. Filters and reveal requests are shared; display
// state stays with each client. Git operations live in the repository overlay.

import { test, expect } from '@playwright/test'
import { describeShared, sessionOp, seedShared, snapshot, type SharedClient } from '../fixtures/shared-workspace'

type ReviewSnapshot = {
  review: { agentChanges?: { panelId?: string } }
  recorded: { files: { path: string }[] }
  reveal: { seq: number; path: string } | null
  busy: boolean
  error: string | null
}
const rv = (c: SharedClient, id: string) => snapshot<ReviewSnapshot>(c, id)
const files = async (c: SharedClient, id: string) => ((await rv(c, id))?.recorded.files ?? []).map((f) => f.path).sort()

describeShared('review', (pair) => {
  let panelId: string
  let nodeId: string

  test('a review opens the same recorded-edit view in both clients', async () => {
    const { a, b } = pair()
    ;({ panelId, nodeId } = await seedShared(pair(), a, 'review', { x: 80, y: 80 }))
    for (const c of [a, b]) {
      await expect.poll(async () => ({ files: await files(c, panelId), error: (await rv(c, panelId))?.error ?? null }), { timeout: 30_000 })
        .toEqual({ files: [], error: null })
    }
  })


  test('an open request reveals its file to both clients; the reader\'s focus stays theirs', async () => {
    const { a, b } = pair()
    await sessionOp(a, panelId, { kind: 'retarget', request: { focusedFile: 'alpha.ts' } })
    await expect.poll(async () => (await rv(b, panelId))?.reveal?.path).toBe('alpha.ts')
    expect(Object.keys((await rv(b, panelId))!.review)).not.toContain('focusedFile')
  })

})

describeShared('review in a folder that is not a Git repository', (pair) => {
  test('B picks Agent Review in a non-repository: both clients show the recorded edits view', async () => {
    const { a, b } = pair()
    const { panelId, nodeId } = await seedShared(pair(), a, 'surface', { x: 80, y: 80 })
    const picker = b.page.locator(`[data-node-id="${nodeId}"] [role="group"][aria-label="Open a surface"]`)
    await expect(picker).toBeVisible({ timeout: 15_000 })
    const overlay = b.page.locator(`[data-node-id="${nodeId}"] [data-unfocused-overlay]`)
    if (await overlay.count()) await overlay.click()
    await picker.getByRole('button', { name: /Agent Review/ }).click()
    for (const c of [a, b]) {
      await expect.poll(async () => {
        const s = await snapshot<ReviewSnapshot & { recorded: { loading: boolean } }>(c, panelId)
        return s && { loading: s.recorded.loading, error: s.error }
      }, { timeout: 20_000 }).toEqual({ loading: false, error: null })
      await expect(c.page.locator(`[data-node-id="${nodeId}"]`)).toContainText('No recorded changes yet')
      await expect(c.page.locator(`[data-node-id="${nodeId}"]`)).not.toContainText('fatal:')
    }
  })
}, { git: false })
