// E2E: the content Search view (an editor's search sidebar), end-to-end
// against the runtime's real ripgrep engine on an isolated fixture project:
// query, match options, filters, dismissal, keyboard nav, and open-at-match.

import { test, expect } from '@playwright/test'
import path from 'node:path'
import { closeApp } from './fixtures/electron-app'
import { launchSearchApp, openSearch, searchSnapshot, settle, type SearchApp } from './fixtures/search-project'

test.describe('content search', () => {
  let app: SearchApp

  test.beforeEach(async () => { app = await launchSearchApp() })
  test.afterEach(async () => closeApp(app.electronApp))

  const node = () => app.mainWindow.locator(`[data-node-id="${app.editor.nodeId}"]`)
  const snap = () => searchSnapshot(app.mainWindow, app.editor.nodeId)
  const settled = () => settle(app.mainWindow, app.editor.nodeId)
  const editorFile = () => app.mainWindow.evaluate((id) => window.__cateE2E!.sessionSnapshot(id), app.editor.panelId) as Promise<{ filePath: string; reveal: { line: number } | null }>

  test('searches the fixture project, highlights matches, and opens a result', async () => {
    const input = await openSearch(app)
    await input.fill('registerSearchHandlers')
    await expect(node().getByText(/results? in .* files?/i)).toBeVisible({ timeout: 30_000 })
    await expect(node().locator('mark', { hasText: 'registerSearchHandlers' }).first()).toBeVisible()
    const target = node().locator('[data-testid="search-line"][data-path$="search-registration.ts"]').first()
    await target.locator('mark').first().click()
    await expect.poll(async () => (await editorFile()).filePath, { timeout: 30_000 }).toBe(path.join(app.root, 'src/features/search-registration.ts'))
  })

  test('shows "No results" for a query that matches nothing', async () => {
    const input = await openSearch(app)
    await input.fill('zzz_no_such_token_qwerty_12345')
    await expect(node().getByText('No results')).toBeVisible({ timeout: 30_000 })
  })

  test('regex toggle changes literal vs pattern matching', async () => {
    const input = await openSearch(app)
    await input.fill(['useState', 'useEffect'].join('|')) // literal: no such contiguous text
    expect((await settled()).totalMatches).toBe(0)
    await node().locator('button[aria-label="Use Regular Expression"]').click()
    await expect.poll(async () => (await snap()).totalMatches, { timeout: 30_000 }).toBeGreaterThan(0)
    expect((await settled()).isRegex).toBe(true)
  })

  test('invalid regex surfaces an inline error', async () => {
    const input = await openSearch(app)
    await node().locator('button[aria-label="Use Regular Expression"]').click()
    await input.fill('(unclosed')
    await expect(node().locator('.text-red-400')).toBeVisible({ timeout: 30_000 })
  })

  test('whole-word toggle narrows matches', async () => {
    const input = await openSearch(app)
    await input.fill('use')
    const loose = (await settled()).totalMatches
    expect(loose).toBeGreaterThan(0)
    await node().locator('button[aria-label="Match Whole Word"]').click()
    await expect.poll(async () => (await snap()).totalMatches, { timeout: 30_000 }).toBeLessThan(loose)
    expect((await settled()).wholeWord).toBe(true)
  })

  test('match-case toggle flips state and re-runs', async () => {
    const input = await openSearch(app)
    await input.fill('usestate')
    const loose = (await settled()).totalMatches
    expect(loose).toBeGreaterThan(0)
    await node().locator('button[aria-label="Match Case"]').click()
    await expect.poll(async () => (await snap()).totalMatches, { timeout: 30_000 }).toBe(0)
    expect((await settled()).matchCase).toBe(true)
  })

  test('files-to-include glob restricts results', async () => {
    const input = await openSearch(app)
    await input.fill('useState')
    expect((await settled()).filePaths.some((p) => p.endsWith('.ts'))).toBe(true)
    await node().locator('button[aria-label="Toggle search details"]').click()
    await node().locator('input[aria-label="files to include"]').fill('*.tsx')
    await expect.poll(async () => (await snap()).filePaths.every((p) => p.endsWith('.tsx')), { timeout: 30_000 }).toBe(true)
    expect((await settled()).fileCount).toBeGreaterThan(0)
  })

  test('files-to-exclude glob removes results', async () => {
    const input = await openSearch(app)
    await input.fill('useState')
    expect((await settled()).filePaths.some((p) => p.endsWith('.tsx'))).toBe(true)
    await node().locator('button[aria-label="Toggle search details"]').click()
    await node().locator('input[aria-label="files to exclude"]').fill('*.tsx')
    await expect.poll(async () => (await snap()).filePaths.some((p) => p.endsWith('.tsx')), { timeout: 30_000 }).toBe(false)
  })

  test('"use ignore files" toggle flips and re-runs', async () => {
    const input = await openSearch(app)
    await input.fill('registerSearchHandlers')
    const initial = await settled()
    expect(initial.filePaths.some((file) => file.includes('ignored'))).toBe(false)
    await node().locator('button[aria-label="Toggle search details"]').click()
    expect((await snap()).respectIgnore).toBe(true)
    await node().getByText('Use ignore files').click()
    await expect.poll(async () => (await snap()).filePaths.some((file) => file.includes('ignored')), { timeout: 30_000 }).toBe(true)
    const s = await settled()
    expect(s.respectIgnore).toBe(false)
    expect(s.error).toBeNull()
    expect(s.totalMatches).toBeGreaterThan(initial.totalMatches)
  })

  test('dismissing a match removes its line', async () => {
    const input = await openSearch(app)
    await input.fill('registerSearchHandlers')
    const before = (await settled()).lines
    expect(before).toBeGreaterThan(0)
    const line = node().locator('[data-testid="search-line"]').first()
    await line.hover()
    await line.getByRole('button', { name: 'Dismiss match' }).click()
    await expect.poll(async () => (await snap()).lines).toBe(before - 1)
  })

  test('dismissing a file removes it from results', async () => {
    const input = await openSearch(app)
    await input.fill('registerSearchHandlers')
    const before = (await settled()).filePaths.length
    const file = node().locator('[data-testid="search-file"]').first()
    await file.hover()
    await file.getByRole('button', { name: 'Dismiss file' }).click()
    await expect.poll(async () => (await snap()).filePaths.length).toBe(before - 1)
  })

  test('keyboard: ArrowDown + Enter opens the focused match', async () => {
    const input = await openSearch(app)
    await input.fill('registerSearchHandlers')
    await settled()
    const tree = node().locator('[data-testid="search-results"]')
    await tree.press('ArrowDown') // file row (0) -> first match line (1)
    const selected = node().locator('[data-selected="true"]')
    await expect(selected).toHaveAttribute('data-testid', 'search-line')
    const expected = await selected.getAttribute('data-path')
    const line = Number(await selected.getAttribute('data-line'))
    await tree.press('Enter')
    await expect.poll(async () => { const s = await editorFile(); return `${s.filePath}:${s.reveal?.line}` }, { timeout: 30_000 }).toBe(`${expected}:${line}`)
  })

  test('clicking a match opens the editor at that line', async () => {
    const input = await openSearch(app)
    await input.fill('registerSearchHandlers')
    await settled()
    const line = node().locator('[data-testid="search-line"]').first()
    const lineNo = Number(await line.getAttribute('data-line'))
    expect(lineNo).toBeGreaterThan(0)
    await line.click()
    await expect.poll(async () => (await editorFile()).reveal?.line, { timeout: 30_000 }).toBe(lineNo)
  })

  test('clear button resets the query and results', async () => {
    const input = await openSearch(app)
    await input.fill('useState')
    expect((await settled()).fileCount).toBeGreaterThan(0)
    await node().locator('button[aria-label="Clear search"]').click()
    await expect(input).toHaveValue('')
    const s = await snap()
    expect(s.filePaths).toHaveLength(0)
    expect(s.status).toBe('idle')
  })
})
