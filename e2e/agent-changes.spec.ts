// Agent change capture end to end: a stand-in agent CLI running in a real Cate
// terminal posts hook events with the credentials the PTY inherited
// (CATE_HOOK_ENDPOINT/TOKEN, CATE_TERMINAL_ID); the runtime records them per
// panel and session, and the terminal's "Open agent changes" pill opens a
// review filtered to that panel. See AGENT_CHANGES.md.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { closeApp, expectTerminalText, launchApp, makeHome, makeProject, seedOnCanvas } from './fixtures/electron-app'
import { stopRuntimeGracefully } from './fixtures/runtime-install'

let app: ElectronApplication
let page: Page
let home: string
let directory: string
let userDataDir: string

test.beforeEach(async () => {
  home = makeHome()
  directory = realpathSync(makeProject(home, { git: true }))
  userDataDir = path.join(home, 'ud')
  ;({ electronApp: app, mainWindow: page } = await launchApp({ home, userDataDir, workspace: directory }))
})
test.afterEach(async () => closeApp(app, { home }))

type Record = { agentId: string; sessionId: string; panelId?: string; files: { path: string; additions: number; deletions: number }[] }
const records = () => page.evaluate((cwd) => window.__cateE2E!.call('agents', 'readChanges', { cwd }), directory)
  .then((snapshot) => ((snapshot as { records?: Record[] }).records ?? []))

async function runFixture(panelId: string, agentId: string, session: string, file: string) {
  const fixture = path.resolve(__dirname, 'fixtures/emit-agent-change.cjs')
  // Quoted absolute paths; the fixture process inherits the PTY's hook credentials.
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} ${agentId} ${session} ${file}\r`
  await expectTerminalText(page, panelId, /\S/)
  await page.evaluate(({ panelId, command }) => window.__cateE2E!.writeTerminal(panelId, command), { panelId, command })
  await expectTerminalText(page, panelId, 'CAPTURE_FIXTURE_DONE')
}

for (const agentId of ['claude-code', 'codex', 'cursor', 'grok', 'kiro', 'opencode']) {
  test(`${agentId}: real terminal hooks reach the filtered review without other sessions or Git changes`, async () => {
    writeFileSync(path.join(directory, 'unrelated.ts'), 'unreported workspace edit\n')
    const source = await seedOnCanvas(page, 'terminal', { x: 100, y: 100 })
    await runFixture(source.panelId, agentId, 'session-one', 'own.ts')
    await expect.poll(records, { timeout: 20_000 }).toMatchObject([
      { agentId, sessionId: 'session-one', panelId: source.panelId, files: [{ path: 'own.ts', additions: 1, deletions: 1 }] },
    ])

    const other = await seedOnCanvas(page, 'terminal', { x: 900, y: 100 })
    await runFixture(other.panelId, agentId, 'session-two', 'other.ts')
    await expect.poll(async () => (await records()).length, { timeout: 20_000 }).toBe(2)

    const node = page.locator(`[data-node-id="${source.nodeId}"]`)
    const overlay = node.locator('[data-unfocused-overlay]')
    if (await overlay.count()) await overlay.click()
    await node.getByRole('button', { name: 'Open agent changes' }).click()
    const review = page.locator('[data-review-file="own.ts"]')
    await expect(review).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-review-file="unrelated.ts"]')).toHaveCount(0)
    await expect(page.locator('[data-review-file="other.ts"]')).toHaveCount(0)

    if (agentId === 'codex') {
      // The review panel, its source and the recorded history survive a full
      // app and runtime restart.
      const reviewId = await page.evaluate(() => window.__cateE2E!.panels().find((p) => p.type === 'review')?.id)
      expect(reviewId).toBeTruthy()
      await stopRuntimeGracefully(page, home)
      await closeApp(app)
      ;({ electronApp: app, mainWindow: page } = await launchApp({ home, userDataDir, workspace: directory, canvas: false }))
      await expect.poll(async () => (await records()).length, { timeout: 20_000 }).toBe(2)
      expect(await page.evaluate(() => window.__cateE2E!.panels().map((p) => p.id))).toContain(reviewId)
      // The active tab is client state: pick the review's tab again.
      await page.locator(`[data-tab-panel-id="${reviewId}"]`).click()
      await expect(page.locator('[data-review-file="own.ts"]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-review-file="other.ts"]')).toHaveCount(0)
    }
  })
}
