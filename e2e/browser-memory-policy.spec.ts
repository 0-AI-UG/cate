import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { launchApp, closeApp, makeProject, openWorkspace } from './fixtures/electron-app'
import { createBrowser, browserWebContentsId, browserInvoke, fixtureEvaluate } from './fixtures/browser-control'

test('discards idle manual pages while protecting automation and edited forms', async () => {
  const { electronApp: app, mainWindow: page, home } = await launchApp()
  try {
    await page.clock.install()
    const manual = await createBrowser(page, 'data:text/html,<title>Manual</title><p>Can sleep</p>')
    const visited = await createBrowser(page, 'data:text/html,<title>Visited</title><p>First</p>')
    const visitedId = await browserWebContentsId(page, visited.panelId)
    const automated = await createBrowser(page, 'data:text/html,<title>Automated</title><input aria-label="Name">')
    const edited = await createBrowser(page, 'data:text/html,<title>Edited</title><input>')
    const manualId = await browserWebContentsId(page, manual.panelId)
    await page.evaluate(id => window.__cateE2E!.sessionOp(id, { kind: 'navigate', input: 'data:text/html,<title>Manual second</title><p>Second</p>' }), visited.panelId)
    await expect.poll(() => fixtureEvaluate(app, page, visited, 'document.title')).toBe('Manual second')
    const manualHistory = await app.evaluate(({ webContents }, id) => webContents.fromId(id!)!.navigationHistory.getAllEntries().map(e => e.url), visitedId)
    const automatedId = await browserWebContentsId(page, automated.panelId)
    const editedId = await browserWebContentsId(page, edited.panelId)
    expect(await browserInvoke(page, automated, 'getAXState', { disableDiffing: true })).toMatchObject({ ok: true })
    await fixtureEvaluate(app, page, automated, 'window.__survives = 42')
    await fixtureEvaluate(app, page, edited, `const input = document.querySelector('input'); input.value = 'Unsaved'; input.dispatchEvent(new Event('input', {bubbles:true}));`)
    const footprint = async () => {
      const ids = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(w => w.getType() === 'webview').map(w => ({ id: w.id, pid: w.getOSProcessId() })))
      if (process.platform !== 'darwin') return ids
      return ids.map(({ id, pid }) => {
        const raw = execFileSync('vmmap', ['-summary', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        return { id, pid, footprint: raw.match(/^Physical footprint:\s+(.+)$/m)?.[1] }
      })
    }
    const original = await page.evaluate(() => window.__cateE2E!.selectedWorkspaceId())
    await openWorkspace(page, makeProject(home, { name: 'other' }))
    const before = await footprint()
    await page.clock.fastForward(11 * 60_000)
    await expect.poll(() => browserWebContentsId(page, manual.panelId)).toBeNull()
    expect(await browserWebContentsId(page, automated.panelId)).toBe(automatedId)
    expect(await browserWebContentsId(page, edited.panelId)).toBe(editedId)
    const after = await footprint()
    writeFileSync(test.info().outputPath('browser-discard-memory.json'), JSON.stringify({ before, after }, null, 2))
    console.log('BROWSER_DISCARD', JSON.stringify({ before, after }))
    expect(await fixtureEvaluate(app, page, automated, 'window.__survives')).toBe(42)
    expect(await browserInvoke(page, automated, 'getAXState', { disableDiffing: true })).toMatchObject({ ok: true })
    await page.evaluate(id => window.__cateE2E!.selectWorkspace(id!), original)
    await expect.poll(() => browserWebContentsId(page, manual.panelId)).not.toBeNull()
    expect(await browserWebContentsId(page, manual.panelId)).not.toBe(manualId)
    expect(await browserWebContentsId(page, visited.panelId)).toBe(visitedId)
    expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id!)!.navigationHistory.getAllEntries().map(e => e.url), visitedId)).toEqual(manualHistory)
    expect(await fixtureEvaluate(app, page, edited, `document.querySelector('input').value`)).toBe('Unsaved')
  } finally { await closeApp(app) }
})
