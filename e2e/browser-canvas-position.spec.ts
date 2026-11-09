import { test, expect } from '@playwright/test'
import sharp from 'sharp'
import { launchApp, closeApp } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForBrowserGuest } from './fixtures/perf-helpers'

test('browser pixels and native hit testing follow pan and zoom', async () => {
  const { electronApp: app, mainWindow: page } = await launchApp()
  try {
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 950); w.show(); w.focus() })
    await installPerfHelpers(page)
    const url = `data:text/html,${encodeURIComponent('<style>body{margin:0}button{width:240px;height:100px;background:#00cc88}</style><button onclick="window.clicked=(window.clicked||0)+1">Click after moving</button>')}`
    const { panelId } = await create(page, 'browser', { x: 100, y: 100 }, { url })
    const guestId = await waitForBrowserGuest(page, panelId)
    await page.locator('[data-unfocused-overlay]').click()
    for (const [index, zoom] of [0.55, 1, 0.8].entries()) {
      await page.evaluate(({ zoom, index }) => {
        window.__cateE2E!.setZoom(zoom)
        window.__cateE2E!.setViewport({ x: 40 + index * 30, y: 30 })
      }, { zoom, index })
      const slot = page.locator(`[data-browser-surface-slot="${panelId}"]`)
      const guest = page.locator(`[data-browser-surface="${panelId}"] webview`)
      await expect.poll(async () => {
        const s = await slot.boundingBox(), g = await page.locator(`[data-browser-surface="${panelId}"]`).boundingBox()
        return s && g ? Math.max(Math.abs(s.x - g.x), Math.abs(s.y - g.y), Math.abs(s.width - g.width), Math.abs(s.height - g.height)) : Infinity
      }).toBeLessThan(1)
      const bounds = (await guest.boundingBox())!
      await expect(page.locator(`[data-browser-surface="${panelId}"]`)).toHaveCSS('pointer-events', 'auto')
      await page.mouse.click(bounds.x + 70 * zoom, bounds.y + 45 * zoom)
      await expect.poll(() => app.evaluate(async ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.clicked || 0'), guestId)).toBeGreaterThan(index)
    }
    // A busy guest must keep its last pixels while the parent moves, rather
    // than holding the whole canvas frame until the guest produces another.
    await app.evaluate(async ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript(`
      window.busyDone = false;
      setTimeout(() => { const end = performance.now() + 2500; while (performance.now() < end) {} window.busyDone = true }, 100);
    `), guestId)
    await page.waitForTimeout(250)
    const started = Date.now()
    await page.evaluate(() => { window.__cateE2E!.setZoom(.65); window.__cateE2E!.setViewport({ x: 130, y: 70 }) })
    await page.waitForTimeout(100)
    const bounds = (await page.locator(`[data-browser-surface="${panelId}"] webview`).boundingBox())!
    const screenshot = await page.screenshot({ path: test.info().outputPath('browser-busy-after-gestures.png') })
    expect(Date.now() - started, 'capture moves before the guest unblocks').toBeLessThan(1800)
    const { data, info } = await sharp(screenshot).raw().toBuffer({ resolveWithObject: true })
    const scale = info.width / (await page.evaluate(() => innerWidth))
    const offset = (Math.floor((bounds.y + 10) * scale) * info.width + Math.floor((bounds.x + 10) * scale)) * info.channels
    // Native capture can round a color channel by one on this display profile.
    const pixel = [...data.subarray(offset, offset + 3)]
    expect(Math.max(...pixel.map((value, index) => Math.abs(value - [0, 204, 136][index]))), 'the busy page stays visible at its new position').toBeLessThanOrEqual(2)
    await expect.poll(() => app.evaluate(async ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.busyDone'), guestId)).toBe(true)
    await page.mouse.click(bounds.x + 70 * .65, bounds.y + 45 * .65)
    await expect.poll(() => app.evaluate(async ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.clicked || 0'), guestId)).toBe(4)
    await page.screenshot({ path: test.info().outputPath('browser-after-gestures.png') })
  } finally { await closeApp(app) }
})
