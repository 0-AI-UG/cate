import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './fixtures/electron-app'
import { createBrowser, browserInvoke, fixtureEvaluate } from './fixtures/browser-control'

test('profiles manual background timers and unattended automation', async () => {
  test.skip(process.env.CATE_THROTTLING_PROFILE !== '1', 'Opt-in background timer experiment')
  const { electronApp: app, mainWindow: page } = await launchApp({ env: { CATE_E2E_BACKGROUND_THROTTLING: '1' } })
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    const browser = await createBrowser(page, 'data:text/html,<title>Timer test</title><p>Alive</p>')
    await app.evaluate(({ webContents }) => { for (const w of webContents.getAllWebContents()) w.setBackgroundThrottling(true) })
    await fixtureEvaluate(app, page, browser, 'window.__ticks = 0; setInterval(() => window.__ticks++, 50)')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
    // Use main-process waits so observing does not foreground the window.
    await app.evaluate(() => new Promise(resolve => setTimeout(resolve, 1500)))
    const before = await fixtureEvaluate(app, page, browser, 'window.__ticks') as number
    await app.evaluate(() => new Promise(resolve => setTimeout(resolve, 2000)))
    const manualTicks = (await fixtureEvaluate(app, page, browser, 'window.__ticks') as number) - before
    expect(await browserInvoke(page, browser, 'getAXState', { disableDiffing: true })).toMatchObject({ ok: true })
    const protectedBefore = await fixtureEvaluate(app, page, browser, 'window.__ticks') as number
    await app.evaluate(() => new Promise(resolve => setTimeout(resolve, 2000)))
    const automatedTicks = (await fixtureEvaluate(app, page, browser, 'window.__ticks') as number) - protectedBefore
    console.log('THROTTLING', JSON.stringify({ manualTicks, automatedTicks, sampleMs: 2000 }))
    expect(automatedTicks).toBeGreaterThan(20)
    expect(await browserInvoke(page, browser, 'getAXState', { disableDiffing: true })).toMatchObject({ ok: true })
  } finally { await closeApp(app) }
})
