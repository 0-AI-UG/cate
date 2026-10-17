import { test, expect } from '@playwright/test'
import { realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { closeApp, launchApp, makeHome, makeProject, seedOnCanvas } from './fixtures/electron-app'

for (const container of ['plain', 'list', 'quote'] as const) {
  test(`Markdown code in ${container} keeps pointer interactions and copies to the native clipboard`, async () => {
    const home = makeHome()
    const root = realpathSync(makeProject(home))
    const source = 'cate panel list ' + 'long-command-argument '.repeat(30)
    const fence = '```sh\n' + source + '\n```\n'
    const markdown = container === 'list' ? '1. Commands\n\n' + fence.split('\n').map(line => '   ' + line).join('\n')
      : container === 'quote' ? fence.split('\n').map(line => '> ' + line).join('\n') : fence
    const file = path.join(root, 'preview.md')
    writeFileSync(file, '# Markdown\n\n' + markdown)
    const app = await launchApp({ home, workspace: root })
    try {
      const page = app.mainWindow
      const { nodeId } = await seedOnCanvas(page, 'editor', { x: 40, y: 40 }, { filePath: file })
      const node = page.locator(`[data-node-id="${nodeId}"]`)
      // Markdown opens in preview; the toggle then reads "Source".
      await expect(node.getByRole('button', { name: 'Source', exact: true })).toBeVisible({ timeout: 15_000 })
      const pre = node.locator('pre')
      await expect(pre).toContainText(source)
      const copy = node.getByRole('button', { name: 'Copy code', exact: true })
      // An unfocused node is dimmed by an overlay that takes the first click.
      const overlay = node.locator('[data-unfocused-overlay]')
      if (await overlay.count()) await overlay.click()
      await pre.hover()
      await copy.click()
      await expect.poll(() => app.electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(source + '\n')

      // Force a measurable native scrollbar even on macOS with overlay scrollbars.
      await page.addStyleTag({ content: 'pre::-webkit-scrollbar { height: 14px; } pre::-webkit-scrollbar-thumb { background: #888; }' })
      for (const zoom of [1, 0.65, 1.8]) {
        await page.evaluate(zoom => window.__cateE2E!.setZoom(zoom), zoom)
        await page.waitForTimeout(100)
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
      await closeApp(app.electronApp, { home })
    }
  })
}
