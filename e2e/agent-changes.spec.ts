import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, closeApp, seedTerminal, resetViewport, titleBarCentre } from './fixtures/electron-app'

let app: ElectronApplication
let page: Page
let directory: string
let workspaceId: string
test.beforeEach(async () => {
  directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'cate-agent-capture-e2e-')))
  ;({ electronApp: app, mainWindow: page } = await launchApp({ userDataDir: path.join(directory, 'userdata') }))
  const opened = page.evaluate((cwd) => window.__cateE2E!.setWorkspaceRoot(cwd), directory)
  const trust = page.getByRole('button', { name: 'Trust and open' })
  if (await trust.isVisible({ timeout: 2000 }).catch(() => false)) await trust.click()
  expect(await opened).toBe(true)
  workspaceId = await page.evaluate(() => window.__cateE2E!.selectedWorkspaceId())
  await resetViewport(page)
})
test.afterEach(async () => { if (app) await closeApp(app); rmSync(directory, { recursive: true, force: true }) })

for (const agentId of ['claude-code', 'codex', 'cursor', 'grok', 'kiro', 'opencode']) {
  test(`${agentId}: real terminal hooks reach the filtered diff panel without other sessions or Git changes`, async () => {
    writeFileSync(path.join(directory, 'unrelated.ts'), 'unreported workspace edit\n')
    const node = await seedTerminal(page, { x: 100, y: 100 })
    await page.waitForFunction((id) => !!window.__cateE2E!.terminalPtyId(id), node)
    const fixture = path.resolve(__dirname, 'fixtures/emit-agent-change.cjs')
    // Quoted absolute paths; the fixture process inherits the PTY's real auth.
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} ${agentId} session-one own.ts\r`
    await page.evaluate(({ node, command }) => window.__cateE2E!.writeTerminal(node, command), { node, command })
    await expect.poll(() => page.evaluate((id) => window.__cateE2E!.terminalText(id), node)).toContain('CAPTURE_FIXTURE_DONE')
    await expect.poll(() => page.evaluate(({ cwd, workspaceId }) => window.electronAPI.agentChangesList(cwd, workspaceId), { cwd: directory, workspaceId })).toMatchObject([
      { agentId, sessionId: 'session-one', files: [{ path: 'own.ts', additions: 1, deletions: 1, coverage: 'fragment' }] },
    ])
    const records = await page.evaluate(({ cwd, workspaceId }) => window.electronAPI.agentChangesList(cwd, workspaceId), { cwd: directory, workspaceId })
    expect(records).toHaveLength(1)
    const other = await seedTerminal(page, { x: 800, y: 100 })
    await page.waitForFunction((id) => !!window.__cateE2E!.terminalPtyId(id), other)
    await page.evaluate(({ node, command }) => window.__cateE2E!.writeTerminal(node, command), { node: other, command: `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} ${agentId} session-two other.ts\r` })
    await expect.poll(() => page.evaluate(({ cwd, workspaceId }) => window.electronAPI.agentChangesList(cwd, workspaceId), { cwd: directory, workspaceId })).toHaveLength(2)
    await resetViewport(page)
    const sourceTitle = await titleBarCentre(page, node)
    await page.mouse.click(sourceTitle!.x, sourceTitle!.y + 60)
    await page.screenshot({ path: test.info().outputPath('terminal-capture.png') })
    await page.locator(`[data-node-id="${node}"]`).getByRole('button', { name: 'Open agent changes' }).click({ timeout: 5000 })
    await page.getByRole('button', { name: 'Create new review at position 1', exact: true }).click()
    await expect(page.locator('[data-review-file="own.ts"]')).toBeVisible()
    await expect(page.locator('[data-review-file="unrelated.ts"]')).toHaveCount(0)
    await expect(page.locator('[data-review-file="other.ts"]')).toHaveCount(0)
    await expect(page.getByLabel('Comparison')).toHaveValue('agent')
    await page.getByRole('button', { name: 'Filters', exact: true }).click()
    await expect(page.getByLabel('Filter by panel')).toHaveValue(records[0].panelId!)
    await page.getByLabel('Filter by agent').selectOption(agentId === 'codex' ? 'claude-code' : 'codex')
    await expect(page.locator('[data-review-file="own.ts"]')).toHaveCount(0)
    await page.getByLabel('Filter by agent').selectOption(agentId)
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.locator('[data-review-file="own.ts"]')).toBeVisible()
    const reviewNode = await page.locator('[data-review-file="own.ts"]').evaluate((element) => element.closest('[data-node-id]')!.getAttribute('data-node-id')!)
    const title = await titleBarCentre(page, reviewNode)
    await page.mouse.click(title!.x, title!.y)
    await page.getByRole('button', { name: 'Collapse all files', exact: true }).click()
    await expect(page.locator('[data-review-file="own.ts"] button[aria-expanded]')).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: 'Expand all files', exact: true }).click()
    await page.getByRole('button', { name: 'Switch to split diff', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Switch to unified diff', exact: true })).toBeVisible()
    if (agentId === 'codex') {
      // The workspace, review panel, source association and recorded history
      // must all survive a full app/runtime restart, not only a fresh launch.
      await closeApp(app)
      ;({ electronApp: app, mainWindow: page } = await launchApp({ userDataDir: path.join(directory, 'userdata') }))
      await expect(page.getByText('This review panel hit an error')).toHaveCount(0)
      await resetViewport(page)
      const restoredSource = await titleBarCentre(page, node)
      expect(restoredSource).not.toBeNull()
      await page.mouse.click(restoredSource!.x, restoredSource!.y + 60)
      await page.locator(`[data-node-id="${node}"]`).getByRole('button', { name: 'Open agent changes' }).click()
      await page.getByRole('button', { name: /Use Agent changes/ }).click()
      await expect(page.locator('[data-review-file="own.ts"]')).toBeVisible()
      await expect(page.locator('[data-review-file="other.ts"]')).toHaveCount(0)
      await expect(page.getByText('This review panel hit an error')).toHaveCount(0)
    }
  })
}
