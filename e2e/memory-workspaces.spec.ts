import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { launchApp, closeApp, makeProject, openWorkspace, addCanvas } from './fixtures/electron-app'
import { memoryAudit } from './fixtures/memory-audit'
import { create, installPerfHelpers, waitForPty, waitForBrowserGuest } from './fixtures/perf-helpers'

test('reports RAM for many inactive workspaces', async () => {
  test.skip(process.env.CATE_MEMORY_AUDIT !== '1', 'Opt in with CATE_MEMORY_AUDIT=1')
  test.skip(process.platform === 'win32', 'Uses POSIX ps')
  test.setTimeout(300_000)
  const { electronApp: app, mainWindow: page, home } = await launchApp({ workspace: false })
  const { samples, sample } = await memoryAudit(app, page, home)
  try {
    await installPerfHelpers(page)
    await sample('shell-only')
    const workspaces: string[] = []
    for (let i = 1; i <= 10; i++) {
      workspaces.push(await openWorkspace(page, makeProject(home, { name: `project-${i}` })))
      await addCanvas(page)
      if ([1, 5, 10].includes(i)) await sample(`${i}-empty-workspaces`)
    }
    // Every workspace was selected and rendered; only the last is selected now.
    for (const workspace of workspaces) {
      await page.evaluate(id => window.__cateE2E!.selectWorkspace(id), workspace)
      const terminal = await create(page, 'terminal', { x: 40, y: 40 })
      await waitForPty(page, terminal.panelId)
    }
    await sample('10-workspaces-one-idle-terminal-each')
    for (const workspace of workspaces) {
      await page.evaluate(id => window.__cateE2E!.selectWorkspace(id), workspace)
      const browser = await create(page, 'browser', { x: 700, y: 40 }, { url: 'data:text/html,<title>Workspace RAM</title><p>Tiny local page</p>' })
      await waitForBrowserGuest(page, browser.panelId)
    }
    await sample('10-workspaces-terminal-and-browser-each')
    await page.waitForTimeout(20_000)
    await sample('10-workspaces-idle-20s')
    expect(await page.evaluate(() => window.__cateE2E!.workspaceIds().length)).toBe(10)
  } finally {
    const reportPath = test.info().outputPath('memory-workspaces.json')
    writeFileSync(reportPath, JSON.stringify({
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      platform: process.platform, arch: process.arch,
      note: 'Fresh isolated device. One selected workspace; other workspaces inactive. Empty temporary projects. Default lifetime settings. Five samples per stage after 2.5s settle; no forced GC. Sum RSS double-counts shared pages.',
      samples,
    }, null, 2) + '\n')
    await test.info().attach('memory-workspaces.json', { path: reportPath, contentType: 'application/json' })
    console.log('RAM report:', reportPath)
    await closeApp(app)
  }
})
