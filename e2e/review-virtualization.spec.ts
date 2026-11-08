import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchApp, closeApp, makeHome, makeProject } from './fixtures/electron-app'
import { create } from './fixtures/perf-helpers'

test('large review scrolls to the end and retains an offscreen comment draft', async () => {
  const home = makeHome()
  const project = makeProject(home, { git: true, files: { 'large.ts': Array.from({ length: 2000 }, (_, i) => `const value${i} = 'before'`).join('\n') } })
  execFileSync('git', ['add', '.'], { cwd: project })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture'], { cwd: project })
  writeFileSync(path.join(project, 'large.ts'), Array.from({ length: 2000 }, (_, i) => `const value${i} = 'after'`).join('\n'))
  const { electronApp: app, mainWindow: page } = await launchApp({ home, workspace: project })
  try {
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 950); w.show(); w.focus() })
    await create(page, 'review', { x: 20, y: 20 }, { repoPath: project })
    await page.locator('[data-unfocused-overlay]').click()
    const scroll = page.locator('[data-review-scroll]')
    await expect(page.getByRole('button', { name: 'Add review note on old line 1', exact: true })).toBeAttached()
    expect(await page.locator('[data-review-file] *').count()).toBeLessThan(10000)
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight })
    const last = page.getByRole('button', { name: 'Add review note on new line 2000', exact: true })
    await expect(last).toBeVisible()
    await last.click()
    const draft = page.getByRole('textbox', { name: 'Review note', exact: true })
    await draft.fill('Keep this draft while scrolling')
    await scroll.evaluate(el => { el.scrollTop = 0 })
    await expect(draft).toHaveValue('Keep this draft while scrolling')
    await expect(page.getByRole('button', { name: 'Add review note on old line 1', exact: true })).toBeVisible()
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight })
    await expect(draft).toBeVisible()
    await draft.locator('..').getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await page.locator('[data-review-file] *').count()).toBeLessThan(10000)
    await page.screenshot({ path: test.info().outputPath('large-review-bottom.png') })
  } finally { await closeApp(app, { home }) }
})
