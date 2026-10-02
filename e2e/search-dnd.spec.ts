// E2E: drag & drop from Search results. Uses synthetic HTML5 DragEvents with a
// shared DataTransfer (the only way to carry the application/cate-file-refs MIME
// payload; Playwright's mouse drag produces an empty dataTransfer). Dispatches
// dragstart on the real Search row (so SearchResultsTree fills the payload)
// then drop on the target, exercising the full source -> target chain.

import { test, expect, type Page } from '@playwright/test'
import { closeApp } from './fixtures/electron-app'
import { launchSearchApp, openSearch, settle, type SearchApp } from './fixtures/search-project'

async function dragRowToTarget(page: Page, nodeId: string, rowTestId: string, targetSelector: string) {
  await page.evaluate(
    ({ nodeId, rowTestId, targetSelector }) => {
      // Rows of a file the host editor does not show (a drop of an open file reveals it).
      const row = document.querySelector(`[data-node-id="${nodeId}"] [data-testid="${rowTestId}"][data-path$="search-registration.ts"]`)
      const target = document.querySelector(targetSelector)
      if (!row || !target) throw new Error(`missing row(${rowTestId}) or target(${targetSelector})`)
      const dt = new DataTransfer()
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      const rect = target.getBoundingClientRect()
      const opts: DragEventInit = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }
      target.dispatchEvent(new DragEvent('dragenter', opts))
      target.dispatchEvent(new DragEvent('dragover', opts))
      target.dispatchEvent(new DragEvent('drop', opts))
    },
    { nodeId, rowTestId, targetSelector },
  )
}

const editors = (page: Page) => page.evaluate(() => window.__cateE2E!.panels().filter((p) => p.type === 'editor').map((p) => p.id))

test.describe('search drag & drop', () => {
  let app: SearchApp
  test.beforeEach(async () => {
    app = await launchSearchApp()
    const input = await openSearch(app)
    await input.fill('registerSearchHandlers')
    await settle(app.mainWindow, app.editor.nodeId)
  })
  test.afterEach(async () => closeApp(app.electronApp))

  test('dragging a file result onto the canvas opens a floating editor', async () => {
    const page = app.mainWindow
    const before = await page.evaluate(() => window.__cateE2E!.nodes().length)
    const path = await page.locator(`[data-node-id="${app.editor.nodeId}"] [data-testid="search-file"][data-path$="search-registration.ts"]`).getAttribute('data-path')
    await dragRowToTarget(page, app.editor.nodeId, 'search-file', '[data-filedrop="canvas"]')
    await expect.poll(() => page.evaluate(() => window.__cateE2E!.nodes().length), { timeout: 30_000 }).toBeGreaterThan(before)
    const opened = (await editors(page)).filter((id) => id !== app.editor.panelId)
    expect(opened).toHaveLength(1)
    await expect.poll(async () => (await page.evaluate((id) => window.__cateE2E!.sessionSnapshot(id), opened[0]!) as { filePath: string }).filePath).toBe(path)
  })

  test('dragging a match line onto the canvas opens it at that line', async () => {
    const page = app.mainWindow
    const lineNo = Number(await page.locator(`[data-node-id="${app.editor.nodeId}"] [data-testid="search-line"][data-path$="search-registration.ts"]`).first().getAttribute('data-line'))
    expect(lineNo).toBeGreaterThan(0)
    await dragRowToTarget(page, app.editor.nodeId, 'search-line', '[data-filedrop="canvas"]')
    await expect.poll(async () => (await editors(page)).length, { timeout: 30_000 }).toBe(2)
    const opened = (await editors(page)).find((id) => id !== app.editor.panelId)!
    await expect.poll(async () => (await page.evaluate((id) => window.__cateE2E!.sessionSnapshot(id), opened) as { reveal: { line: number } | null }).reveal?.line, { timeout: 30_000 }).toBe(lineNo)
  })

  test('dragging a file result onto the dock opens an editor tab', async () => {
    const page = app.mainWindow
    await dragRowToTarget(page, app.editor.nodeId, 'search-file', '[data-filedrop="dock"]')
    await expect.poll(async () => (await editors(page)).length, { timeout: 30_000 }).toBe(2)
    const opened = (await editors(page)).find((id) => id !== app.editor.panelId)!
    // A dock tab, not a canvas node.
    expect(await page.evaluate((id) => window.__cateE2E!.nodeForPanel(id), opened)).toBeNull()
  })
})
