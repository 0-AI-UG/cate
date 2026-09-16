import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { closeApp, launchApp } from './fixtures/electron-app'
import { openTrustedWorkspace } from './fixtures/workspace'

let app: ElectronApplication
let page: Page
let project: string
test.beforeEach(async () => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), 'cate-connected-editor-')))
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  await openTrustedWorkspace(page, project)
})
test.afterEach(async () => {
  if (app) await closeApp(app)
  rmSync(project, { recursive: true, force: true })
})

for (const untitled of [true, false]) {
  test(`${untitled ? 'untitled' : 'opened'} connected editor shares real file changes`, async () => {
    const existing = path.join(project, 'existing.txt')
    writeFileSync(existing, 'Original text')
    const source = await page.evaluate(() => window.__cateE2E!.createPanel('terminal'))
    const editor = await page.evaluate(file => window.__cateE2E!.createPanel('editor', file), untitled ? undefined : existing)
    await page.locator('.monaco-editor textarea').first().focus()
    if (!untitled) await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.type('User draft')
    await expect.poll(() => page.evaluate(id => window.__cateE2E!.panels().find(p => p.id === id)?.isDirty, editor)).toBe(true)
    await page.evaluate(({ source, editor }) => window.__cateE2E!.connectPanels(source, editor), { source, editor })
    await expect(page.getByText('Shared with agent', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(id => window.__cateE2E!.panels().find(p => p.id === id)?.filePath, editor)).toBeTruthy()
    const workingPath = await page.evaluate(id => window.__cateE2E!.panels().find(p => p.id === id)!.filePath!, editor)
    await expect.poll(() => readFileSync(workingPath, 'utf8')).toBe('User draft')
    if (untitled) expect(workingPath).toContain(`${path.sep}.cate${path.sep}drafts${path.sep}`)
    else expect(workingPath).toBe(existing)

    // The same plain filesystem write an agent performs must update Monaco.
    writeFileSync(workingPath, 'Agent wrote this')
    await expect(page.locator('.monaco-editor').first()).toContainText('Agent wrote this', { timeout: 15_000 })
    await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.type('User updated this')
    await expect.poll(() => readFileSync(workingPath, 'utf8')).toBe('User updated this')

    if (untitled) {
      const promoted = path.join(project, 'saved.md')
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      }, promoted)
      await page.getByRole('button', { name: 'Save As…', exact: true }).click()
      await expect.poll(() => page.evaluate(id => window.__cateE2E!.panels().find(p => p.id === id)?.filePath, editor)).toBe(promoted)
      expect(readFileSync(promoted, 'utf8')).toBe('User updated this')
      writeFileSync(promoted, 'Agent updated saved file')
      await expect(page.locator('.monaco-editor').first()).toContainText('Agent updated saved file')
    }
  })
}
