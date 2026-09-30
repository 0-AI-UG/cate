// Connected editors (relations 9.7): an editor related to an execution panel
// (a terminal) autosaves to a real file an agent can read, and plain
// filesystem writes to that file show in Monaco.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { closeApp, launchApp, seedOnCanvas } from './fixtures/electron-app'

let app: ElectronApplication
let page: Page
let project: string
test.beforeEach(async () => {
  let raw: string | null
  ;({ electronApp: app, mainWindow: page, project: raw } = await launchApp())
  project = realpathSync(raw!)
})
test.afterEach(async () => closeApp(app))

type EditorSnapshot = { filePath: string | null; dirty: boolean; connectedDraft: unknown }
const snapshot = (id: string) => page.evaluate((panelId) => window.__cateE2E!.sessionSnapshot(panelId), id) as Promise<EditorSnapshot | null>
const selectAll = process.platform === 'darwin' ? 'Meta+A' : 'Control+A'

for (const untitled of [true, false]) {
  test(`${untitled ? 'untitled' : 'opened'} connected editor shares real file changes`, async () => {
    const existing = path.join(project, 'existing.txt')
    writeFileSync(existing, 'Original text')
    const source = await seedOnCanvas(page, 'terminal', { x: 40, y: 40 })
    const editor = await seedOnCanvas(page, 'editor', { x: 800, y: 40 }, untitled ? {} : { filePath: existing })
    const monaco = page.locator(`[data-node-id="${editor.nodeId}"] .monaco-editor`)
    await monaco.waitFor({ timeout: 30_000 })
    if (!untitled) await expect(monaco).toContainText('Original text')
    await monaco.locator('textarea').first().focus()
    if (!untitled) await page.keyboard.press(selectAll)
    await page.keyboard.type('User draft')
    await expect.poll(async () => (await snapshot(editor.panelId))?.dirty).toBe(true)

    await page.evaluate(({ from, to }) => window.__cateE2E!.propose({
      kind: 'addRelation',
      relation: { id: crypto.randomUUID(), fromPanelId: from, toPanelId: to, kind: 'context' },
    }), { from: source.panelId, to: editor.panelId })
    await expect(page.getByText('Shared with agent', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect.poll(async () => (await snapshot(editor.panelId))?.filePath).toBeTruthy()
    const workingPath = (await snapshot(editor.panelId))!.filePath!
    await expect.poll(() => readFileSync(workingPath, 'utf8')).toBe('User draft')
    if (untitled) expect(workingPath).toContain(`${path.sep}.cate${path.sep}drafts${path.sep}`)
    else expect(workingPath).toBe(existing)

    // The same plain filesystem write an agent performs must update Monaco.
    writeFileSync(workingPath, 'Agent wrote this')
    await expect(monaco).toContainText('Agent wrote this', { timeout: 15_000 })
    await monaco.locator('textarea').first().focus()
    await page.keyboard.press(selectAll)
    await page.keyboard.type('User updated this')
    await expect.poll(() => readFileSync(workingPath, 'utf8')).toBe('User updated this')

    if (untitled) {
      const promoted = path.join(project, 'saved.md')
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
      }, promoted)
      // The toolbar can run past the window edge on the canvas.
      await page.locator(`[data-node-id="${editor.nodeId}"]`).getByRole('button', { name: 'Save As…', exact: true }).dispatchEvent('click')
      await expect.poll(async () => (await snapshot(editor.panelId))?.filePath).toBe(promoted)
      expect(readFileSync(promoted, 'utf8')).toBe('User updated this')
      writeFileSync(promoted, 'Agent updated saved file')
      await expect(monaco).toContainText('Agent updated saved file', { timeout: 15_000 })
    }
  })
}
