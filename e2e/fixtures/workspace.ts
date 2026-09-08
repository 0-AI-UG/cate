import { expect, type Page } from '@playwright/test'

/** Open through the normal trust UI, including already-trusted directories. */
export async function openTrustedWorkspace(page: Page, directory: string): Promise<void> {
  let finished = false
  // Attach the rejection handler immediately: if readiness fails, teardown may
  // close the page while the workspace request is still awaiting user approval.
  const opened = page.evaluate((root) => window.__cateE2E!.setWorkspaceRoot(root), directory)
    .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
    .then(result => { finished = true; return result })
  const trust = page.getByRole('button', { name: 'Trust and open' })
  await expect.poll(async () => finished || await trust.isVisible(), {
    timeout: 30_000,
    message: 'workspace opens or requests trust',
  }).toBe(true)
  // Opening a saved project can restore webviews whose navigations never
  // settle. The workspace promise, not unrelated guest navigation, is the
  // completion signal for this UI action. Keep normal click actionability.
  if (!finished) await trust.click({ noWaitAfter: true })
  await expect.poll(() => finished, {
    timeout: 30_000,
    message: 'trusted workspace finishes opening',
  }).toBe(true)
  const result = await opened
  if (!result.ok) throw result.error
  expect(result.value).toBe(true)
}
