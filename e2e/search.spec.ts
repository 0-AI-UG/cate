// E2E: the VS Code-style content Search view, end-to-end against the real
// ripgrep engine. Points the workspace at the repo, opens the Search view,
// types a query, and asserts streamed/grouped/highlighted results plus
// open-at-match.

import { test, expect } from '@playwright/test'
import path from 'node:path'
import { launchApp, closeApp, type LaunchResult } from './fixtures/electron-app'

const REPO_ROOT = path.resolve(__dirname, '..')

test.describe('content search', () => {
  let app: LaunchResult

  test.beforeEach(async () => {
    app = await launchApp()
  })

  test.afterEach(async () => {
    await closeApp(app.electronApp)
  })

  test('searches the repo, highlights matches, and opens a result', async () => {
    const page = app.mainWindow

    // Point the selected workspace at the repo so ripgrep has files to scan
    // (this also registers it as an allowed root for path validation).
    const ok = await page.evaluate((root) => window.__cateE2E!.setWorkspaceRoot(root), REPO_ROOT)
    expect(ok).toBe(true)

    // Open the Search view in the sidebar.
    await page.evaluate(() => window.__cateE2E!.openSidebarView('search'))

    // Type a query that definitely exists in the repo (appears in several files).
    const input = page.locator('input[placeholder="Search"]')
    await input.waitFor({ state: 'visible', timeout: 10_000 })
    await input.fill('registerSearchHandlers')

    // The streamed count line appears once results arrive.
    await expect(page.getByText(/results in .* files?/i)).toBeVisible({ timeout: 10_000 })

    // The matched substring is highlighted (<mark>) in a result line.
    const mark = page.locator('mark', { hasText: 'registerSearchHandlers' }).first()
    await expect(mark).toBeVisible({ timeout: 10_000 })

    // Clicking a match opens that file as an editor (open-at-line).
    await mark.click()
    await expect
      .poll(async () => page.evaluate(() => window.__cateE2E!.editorPaths().length), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0)
  })

  test('shows "No results" for a query that matches nothing', async () => {
    const page = app.mainWindow
    await page.evaluate((root) => window.__cateE2E!.setWorkspaceRoot(root), REPO_ROOT)
    await page.evaluate(() => window.__cateE2E!.openSidebarView('search'))

    const input = page.locator('input[placeholder="Search"]')
    await input.waitFor({ state: 'visible', timeout: 10_000 })
    await input.fill('zzz_no_such_token_qwerty_12345')

    await expect(page.getByText('No results')).toBeVisible({ timeout: 10_000 })
  })
})
