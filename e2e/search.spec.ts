// E2E: the VS Code-style content Search view, end-to-end against the real
// ripgrep engine. Points the workspace at the repo, opens the Search view, and
// exercises query, match options, filters, dismissal, keyboard nav, and
// open-at-match.

import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { launchApp, closeApp, type LaunchResult } from './fixtures/electron-app'

const REPO_ROOT = path.resolve(__dirname, '..')

type Snapshot = {
  query: string
  isRegex: boolean
  matchCase: boolean
  wholeWord: boolean
  respectIgnore: boolean
  optionsExpanded: boolean
  status: string
  searchId: string | null
  error: string | null
  fileCount: number
  filePaths: string[]
  totalMatches: number
  dismissedFiles: number
  dismissedLines: number
}

const snap = (page: Page): Promise<Snapshot> =>
  page.evaluate(() => window.__cateE2E!.getSearchSnapshot() as unknown) as Promise<Snapshot>

/** Open the Search view rooted at the repo; returns the query input locator. */
async function openSearch(page: Page) {
  await page.evaluate((root) => window.__cateE2E!.setWorkspaceRoot(root), REPO_ROOT)
  await page.evaluate(() => window.__cateE2E!.openSidebarView('search'))
  const input = page.locator('input[aria-label="Search"]')
  await input.waitFor({ state: 'visible', timeout: 10_000 })
  return input
}

/** Wait until a NEW search (id != prior) has settled. Avoids reading stale
 *  results from a previous search that is still in the 'done' state. */
async function settle(page: Page, priorSearchId: string | null) {
  await expect
    .poll(
      async () => {
        const s = await snap(page)
        return s.searchId !== priorSearchId && s.status === 'done'
      },
      { timeout: 12_000 },
    )
    .toBe(true)
}

/** Run the first search for `query` and wait for it to settle. */
async function search(page: Page, input: ReturnType<Page['locator']>, query: string) {
  const prior = (await snap(page)).searchId
  await input.fill(query)
  await settle(page, prior)
}

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
    const input = await openSearch(page)
    await input.fill('registerSearchHandlers')

    await expect(page.getByText(/results in .* files?/i)).toBeVisible({ timeout: 10_000 })
    const mark = page.locator('mark', { hasText: 'registerSearchHandlers' }).first()
    await expect(mark).toBeVisible({ timeout: 10_000 })

    await mark.click()
    await expect
      .poll(async () => page.evaluate(() => window.__cateE2E!.editorPaths().length), { timeout: 10_000 })
      .toBeGreaterThan(0)
  })

  test('shows "No results" for a query that matches nothing', async () => {
    const page = app.mainWindow
    const input = await openSearch(page)
    await input.fill('zzz_no_such_token_qwerty_12345')
    await expect(page.getByText('No results')).toBeVisible({ timeout: 10_000 })
  })

  test('regex toggle changes literal vs pattern matching', async () => {
    const page = app.mainWindow
    const input = await openSearch(page)
    // Built at runtime so the contiguous literal isn't in this source file
    // (otherwise ripgrep would self-match it during the literal search).
    const pattern = ['useState', 'useEffect'].join('|')
    await search(page, input, pattern) // literal — no such contiguous text
    expect((await snap(page)).totalMatches).toBe(0)

    const prior = (await snap(page)).searchId
    await page.locator('button[aria-label="Use Regular Expression"]').click()
    await settle(page, prior)
    const s = await snap(page)
    expect(s.isRegex).toBe(true)
    expect(s.totalMatches).toBeGreaterThan(0) // now matches as an alternation
  })

  test('invalid regex surfaces an inline error', async () => {
    const page = app.mainWindow
    const input = await openSearch(page)
    await page.locator('button[aria-label="Use Regular Expression"]').click()
    await search(page, input, '(unclosed')
    expect((await snap(page)).error).toBeTruthy()
    await expect(page.locator('.text-red-400')).toBeVisible({ timeout: 5_000 })
  })

  test('whole-word toggle narrows matches', async () => {
    const page = app.mainWindow
    const input = await openSearch(page)
    await search(page, input, 'use')
    const loose = (await snap(page)).totalMatches
    expect(loose).toBeGreaterThan(0)

    const prior = (await snap(page)).searchId
    await page.locator('button[aria-label="Match Whole Word"]').click()
    await settle(page, prior)
    const s = await snap(page)
    expect(s.wholeWord).toBe(true)
    expect(s.totalMatches).toBeLessThan(loose) // "useState" etc. no longer match
  })

  test('match-case toggle flips state and re-runs', async () => {
    const page = app.mainWindow
    const input = await openSearch(page)
    await search(page, input, 'usestate') // lowercase
    const loose = (await snap(page)).totalMatches

    const prior = (await snap(page)).searchId
    await page.locator('button[aria-label="Match Case"]').click()
    await settle(page, prior)
    const s = await snap(page)
    expect(s.matchCase).toBe(true)
    expect(s.totalMatches).toBeLessThanOrEqual(loose) // fewer/zero exact-case hits
  })

  test('files-to-include glob restricts results', async () => {
    const page = app.mainWindow
    const input = await openSearch(page)
    await search(page, input, 'useState')

    await page.locator('button[aria-label="Toggle search details"]').click()
    const prior = (await snap(page)).searchId
    await page.locator('input[aria-label="files to include"]').fill('*.tsx')
    await settle(page, prior)
    const s = await snap(page)
    expect(s.fileCount).toBeGreaterThan(0)
    expect(s.filePaths.every((p) => p.endsWith('.tsx'))).toBe(true)
  })

  test('files-to-exclude glob removes results', async () => {
    const page = app.mainWindow
    const input = await openSearch(page)
    await search(page, input, 'useState')
    expect((await snap(page)).filePaths.some((p) => p.endsWith('.tsx'))).toBe(true)

    await page.locator('button[aria-label="Toggle search details"]').click()
    const prior = (await snap(page)).searchId
    await page.locator('input[aria-label="files to exclude"]').fill('*.tsx')
    await settle(page, prior)
    expect((await snap(page)).filePaths.some((p) => p.endsWith('.tsx'))).toBe(false)
  })

  test('"use ignore files" gear toggle flips and re-runs', async () => {
    const page = app.mainWindow
    const input = await openSearch(page)
    await search(page, input, 'registerSearchHandlers')
    expect((await snap(page)).respectIgnore).toBe(true)

    await page.locator('button[aria-label="Toggle search details"]').click()
    const prior = (await snap(page)).searchId
    await page.locator('button[aria-label="Use Exclude Settings and Ignore Files"]').click()
    await settle(page, prior)
    const s = await snap(page)
    expect(s.respectIgnore).toBe(false)
    expect(s.error).toBeNull()
  })

  test('dismissing a match decrements the count', async () => {
    const page = app.mainWindow
    const input = await openSearch(page)
    await search(page, input, 'registerSearchHandlers')
    expect((await snap(page)).totalMatches).toBeGreaterThan(0)

    const line = page.locator('[data-testid="search-line"]').first()
    await line.hover()
    await line.locator('button[title="Dismiss match"]').click()
    await expect.poll(async () => (await snap(page)).dismissedLines).toBe(1)
  })

  test('dismissing a file removes it from results', async () => {
    const page = app.mainWindow
    const input = await openSearch(page)
    await search(page, input, 'registerSearchHandlers')

    const file = page.locator('[data-testid="search-file"]').first()
    await file.hover()
    await file.locator('button[title="Dismiss file"]').click()
    await expect.poll(async () => (await snap(page)).dismissedFiles).toBe(1)
  })

  test('keyboard: ArrowDown + Enter opens the focused match', async () => {
    const page = app.mainWindow
    const input = await openSearch(page)
    await search(page, input, 'registerSearchHandlers')

    const tree = page.locator('[data-testid="search-results"]')
    await tree.press('ArrowDown') // file row (0) → first match line (1)
    // Selection must move to a match line (proves the list owns its arrow keys).
    await expect(page.locator('[data-selected="true"]')).toHaveAttribute('data-testid', 'search-line')
    await tree.press('Enter')
    await expect
      .poll(async () => page.evaluate(() => window.__cateE2E!.editorPaths().length), { timeout: 10_000 })
      .toBeGreaterThan(0)
  })

  test('clicking a match opens the editor at that line', async () => {
    const page = app.mainWindow
    const input = await openSearch(page)
    await search(page, input, 'registerSearchHandlers')

    const line = page.locator('[data-testid="search-line"]').first()
    const lineNo = Number(await line.getAttribute('data-line'))
    expect(lineNo).toBeGreaterThan(0)
    await line.click()

    const reveal = await page.evaluate(() => window.__cateE2E!.lastEditorReveal())
    expect(reveal?.line).toBe(lineNo)
  })

  test('clear button resets the query and results', async () => {
    const page = app.mainWindow
    const input = await openSearch(page)
    await search(page, input, 'useState')
    expect((await snap(page)).fileCount).toBeGreaterThan(0)

    await page.locator('button[aria-label="Clear search"]').click()
    await expect.poll(async () => (await snap(page)).query).toBe('')
    const s = await snap(page)
    expect(s.fileCount).toBe(0)
    expect(s.status).toBe('idle')
  })
})
