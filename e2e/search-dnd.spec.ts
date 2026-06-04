// E2E: drag & drop from Search results. Uses synthetic HTML5 DragEvents with a
// shared DataTransfer (the only way to exercise the application/cate-file MIME
// payload — Playwright's mouse drag produces an empty dataTransfer). Dispatches
// dragstart on the real Search row (so SearchResultsTree populates the payload)
// then drop on the target, exercising the full source→target chain.

import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { launchApp, closeApp, type LaunchResult } from './fixtures/electron-app'

const REPO_ROOT = path.resolve(__dirname, '..')

async function openSearch(page: Page) {
  await page.evaluate((root) => window.__cateE2E!.setWorkspaceRoot(root), REPO_ROOT)
  await page.evaluate(() => window.__cateE2E!.openSidebarView('search'))
  const input = page.locator('input[aria-label="Search"]')
  await input.waitFor({ state: 'visible', timeout: 30_000 })
  await input.fill('registerSearchHandlers')
  await expect.poll(
    async () => page.evaluate(() => window.__cateE2E!.getSearchSnapshot().status),
    { timeout: 30_000 },
  ).toBe('done')
}

/** Dispatch dragstart on a Search row, then drop it on a target selector. */
async function dragRowToTarget(page: Page, rowTestId: string, targetSelector: string) {
  await page.evaluate(
    ({ rowTestId, targetSelector }) => {
      const row = document.querySelector(`[data-testid="${rowTestId}"]`)
      const target = document.querySelector(targetSelector)
      if (!row || !target) throw new Error(`missing row(${rowTestId}) or target(${targetSelector})`)
      const dt = new DataTransfer()
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      const rect = target.getBoundingClientRect()
      const opts: DragEventInit = {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      }
      target.dispatchEvent(new DragEvent('dragenter', opts))
      target.dispatchEvent(new DragEvent('dragover', opts))
      target.dispatchEvent(new DragEvent('drop', opts))
    },
    { rowTestId, targetSelector },
  )
}

test.describe('search drag & drop', () => {
  let app: LaunchResult
  test.beforeEach(async () => {
    app = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(app.electronApp)
  })

  test('dragging a file result onto the canvas opens a floating editor', async () => {
    const page = app.mainWindow
    await openSearch(page)
    const before = await page.evaluate(() => window.__cateE2E!.nodes().length)

    await dragRowToTarget(page, 'search-file', '[data-canvas-panel-id]')

    await expect
      .poll(async () => page.evaluate(() => window.__cateE2E!.nodes().length), { timeout: 30_000 })
      .toBeGreaterThan(before)
  })

  test('dragging a match line onto the canvas opens it at that line', async () => {
    const page = app.mainWindow
    await openSearch(page)
    const lineNo = Number(
      await page.locator('[data-testid="search-line"]').first().getAttribute('data-line'),
    )
    expect(lineNo).toBeGreaterThan(0)

    await dragRowToTarget(page, 'search-line', '[data-canvas-panel-id]')

    await expect
      .poll(async () => page.evaluate(() => window.__cateE2E!.lastEditorReveal()?.line ?? 0), { timeout: 30_000 })
      .toBe(lineNo)
  })

  test('dragging a file result onto the dock center zone opens an editor tab', async () => {
    const page = app.mainWindow
    await openSearch(page)
    const before = await page.evaluate(() => window.__cateE2E!.editorPaths().length)

    await dragRowToTarget(page, 'search-file', '[data-dock-zone="center"]')

    await expect
      .poll(async () => page.evaluate(() => window.__cateE2E!.editorPaths().length), { timeout: 30_000 })
      .toBeGreaterThan(before)
  })
})
