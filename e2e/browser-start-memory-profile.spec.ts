import { writeFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { launchApp, closeApp, makeProject, openWorkspace, addCanvas, seedOnCanvas } from './fixtures/electron-app'
import { browserInvoke, browserWebContentsId, createBrowser, fixtureEvaluate } from './fixtures/browser-control'
import { memoryAudit } from './fixtures/memory-audit'

test('profiles unused start pages across workspaces and demand creation', async () => {
  test.skip(!process.env.CATE_BROWSER_START_PROFILE)
  test.setTimeout(180_000)
  const { electronApp: app, mainWindow: page, home } = await launchApp()
  try {
    const audit = await memoryAudit(app, page, home)
    const starts: Array<{ workspaceId: string; panelId: string }> = []
    const live = []
    for (let workspace = 0; workspace < 3; workspace++) {
      if (workspace) {
        await openWorkspace(page, makeProject(home, { name: `workspace-${workspace}` }))
        await addCanvas(page)
      }
      const workspaceId = (await page.evaluate(() => window.__cateE2E!.selectedWorkspaceId()))!
      for (let i = 0; i < 4; i++) {
        const { panelId } = await seedOnCanvas(page, 'browser', { x: 100 + i * 40, y: 100 + i * 40 }, { url: 'cate://newtab' })
        starts.push({ workspaceId, panelId })
      }
      const browser = await createBrowser(page, 'data:text/html,<title>Agent task</title><input aria-label="Draft"><p>Working</p>')
      expect(await browserInvoke(page, browser, 'getAXState')).toMatchObject({ ok: true })
      await fixtureEvaluate(app, page, browser, `window.kept = 42; const input = document.querySelector('input'); input.value = 'Draft'; input.dispatchEvent(new Event('input', {bubbles:true}));`)
      live.push({ browser, id: await browserWebContentsId(page, browser.panelId) })
    }
    await audit.sample('three-workspaces-twelve-start-pages-three-agent-pages')
    const guestsBefore = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(w => w.getType() === 'webview').length)
    const start = starts.at(-1)!
    const began = Date.now()
    expect(await browserInvoke(page, start, 'getAXState', { disableDiffing: true })).toMatchObject({ ok: true })
    const demandMs = Date.now() - began
    const demandedId = await browserWebContentsId(page, start.panelId)
    expect(demandedId).not.toBeNull()
    await page.evaluate(id => window.__cateE2E!.sessionOp(id, { kind: 'navigate', input: 'data:text/html,<title>First navigation</title><p>Ready</p>' }), start.panelId)
    await expect.poll(() => fixtureEvaluate(app, page, start, 'document.title')).toBe('First navigation')
    expect(await browserWebContentsId(page, start.panelId)).toBe(demandedId)
    for (const { browser, id } of live) {
      expect(await browserWebContentsId(page, browser.panelId)).toBe(id)
      expect(await fixtureEvaluate(app, page, browser, `[window.kept, document.querySelector('input').value]`)).toEqual([42, 'Draft'])
    }
    // Navigation without a preceding automation call must also create its first guest.
    const manual = starts.at(-2)!
    await page.evaluate(id => window.__cateE2E!.sessionOp(id, { kind: 'navigate', input: 'data:text/html,<title>Manual navigation</title>' }), manual.panelId)
    await expect.poll(() => fixtureEvaluate(app, page, manual, 'document.title')).toBe('Manual navigation')
    writeFileSync(test.info().outputPath('browser-start-memory.json'), JSON.stringify({ label: process.env.CATE_BROWSER_START_PROFILE, guestsBefore, demandMs, samples: audit.samples }, null, 2))
  } finally { await closeApp(app) }
})
