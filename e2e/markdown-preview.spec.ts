import { test, expect } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, closeApp } from './fixtures/electron-app'
import { openTrustedWorkspace } from './fixtures/workspace'

for (const container of ['plain', 'list', 'quote'] as const) {
  test(`Markdown code in ${container} keeps pointer interactions and copies to the native clipboard`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cate-markdown-'))
    const source = 'cate panel list ' + 'long-command-argument '.repeat(30)
    const fence = '```sh\n' + source + '\n```\n'
    const markdown = container === 'list' ? '1. Commands\n\n' + fence.split('\n').map(line => '   ' + line).join('\n')
      : container === 'quote' ? fence.split('\n').map(line => '> ' + line).join('\n') : fence
    writeFileSync(path.join(root, 'preview.md'), '# Markdown\n\n' + markdown)
    const app = await launchApp({ empty: true })
    try {
      const page = app.mainWindow
      await openTrustedWorkspace(page, root)
      await page.evaluate(() => window.__cateE2E!.createPanel('canvas'))
      await page.locator('[data-canvas-panel-id]').waitFor()
      const nodeId = await page.evaluate(() => window.__cateE2E!.createEditor({ x: 40, y: 40 }))
      const node = page.locator(`[data-node-id="${nodeId}"]`)
      await node.getByText('preview.md', { exact: true }).click()
      const pre = node.locator('pre')
      await expect(pre).toContainText(source)
      const copy = node.getByRole('button', { name: 'Copy code', exact: true })
      await pre.hover()
      await copy.click()
      await expect.poll(() => app.electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(source + '\n')

      // Force a measurable native scrollbar even on macOS with overlay scrollbars.
      await page.addStyleTag({ content: 'pre::-webkit-scrollbar { height: 14px; } pre::-webkit-scrollbar-thumb { background: #888; }' })
      for (const zoom of [1, 0.65, 1.8]) {
        await page.evaluate(zoom => window.__cateE2E!.setZoom(zoom), zoom)
        await pre.evaluate(el => { el.scrollLeft = 0 })
        const box = await pre.boundingBox()
        if (!box) throw new Error('Missing code block')
        await page.mouse.move(box.x + 10 * zoom, box.y + box.height - 7 * zoom)
        await page.mouse.down()
        await page.mouse.move(box.x + 100 * zoom, box.y + box.height - 7 * zoom, { steps: 10 })
        await page.mouse.up()
        await expect.poll(() => pre.evaluate(el => el.scrollLeft), { message: `Scrollbar drag at zoom ${zoom}` }).toBeGreaterThan(0)
      }
    } finally {
      await closeApp(app.electronApp)
      rmSync(root, { recursive: true, force: true })
    }
  })
}
