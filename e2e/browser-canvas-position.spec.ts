import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import sharp from 'sharp'
import { addCanvas, closeApp, launchApp, makeProject, openWorkspace } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForBrowserGuest } from './fixtures/perf-helpers'
import { browserInvoke, browserWebContentsId } from './fixtures/browser-control'

test('browser pixels and native hit testing follow pan and zoom', async () => {
  const smoke = process.env.E2E_SKIP_PERF === '1'
  const checkPixels = !smoke || process.platform !== 'win32'
  const chromiumArgs = smoke && process.platform === 'linux' ? ['--use-gl=angle', '--use-angle=swiftshader'] : []
  const { electronApp: app, mainWindow: page, home } = await test.step('Launch Cate', () => launchApp({ workspace: false, chromiumArgs }))
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<style>body{margin:0}button{width:240px;height:100px;background:#00cc88}</style><button onclick="window.clicked=(window.clicked||0)+1">Click after moving</button>')
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test web server has no port')
    const url = `http://127.0.0.1:${address.port}/`
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 950); w.show(); w.focus() })
    const graphics = await app.evaluate(({ app }) => ({
      platform: process.platform,
      arch: process.arch,
      features: app.getGPUFeatureStatus(),
      rasterizationDisabled: app.commandLine.hasSwitch('disable-gpu-rasterization'),
      graphiteDisabled: app.commandLine.hasSwitch('disable-skia-graphite'),
      graphitePrecompile: app.commandLine.hasSwitch('enable-skia-graphite-precompilation'),
      angle: app.commandLine.getSwitchValue('use-angle'),
      gl: app.commandLine.getSwitchValue('use-gl'),
    }))
    console.log('Webview graphics', JSON.stringify(graphics))
    const appleSilicon = graphics.platform === 'darwin' && graphics.arch === 'arm64'
    expect(graphics).toMatchObject({ rasterizationDisabled: false, graphiteDisabled: false, graphitePrecompile: appleSilicon })
    expect([graphics.gl, graphics.angle]).toEqual(chromiumArgs.length ? ['angle', 'swiftshader'] : ['', ''])
    await test.step('Open a workspace and canvas', async () => {
      await openWorkspace(page, makeProject(home))
      await addCanvas(page)
    })
    await installPerfHelpers(page)
    const { panelId, nodeId } = await create(page, 'browser', { x: 100, y: 100 }, { url })
    const guestId = await waitForBrowserGuest(page, panelId)
    await expect.poll(() => app.evaluate(({ webContents }, id) => {
      const guest = webContents.fromId(id)!
      return { url: guest.getURL(), loading: guest.isLoadingMainFrame(), crashed: guest.isCrashed() }
    }, guestId), { timeout: 10_000, message: 'webview navigation commits' }).toEqual({ url, loading: false, crashed: false })
    await expect.poll(() => app.evaluate(({ webContents }, id) =>
      webContents.fromId(id)!.executeJavaScript('document.querySelector("button")?.textContent ?? ""'),
    guestId), { message: 'page loads in the webview' }).toBe('Click after moving')
    // Activate the node before testing native input inside the guest.
    const node = page.locator(`[data-node-id="${nodeId}"]`)
    await node.locator('[data-unfocused-overlay]').dispatchEvent('click')
    await expect(node).toHaveAttribute('data-node-active', 'true')
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
      const x = bounds.x + 30 * zoom
      const y = bounds.y + 25 * zoom
      // Geometry settles before the compositor presents the guest's next frame.
      if (checkPixels) {
        await expect.poll(async () => {
          const screenshot = await page.screenshot({ scale: 'css' })
          const pixel = await sharp(screenshot).extract({ left: Math.floor(x), top: Math.floor(y), width: 1, height: 1 }).removeAlpha().raw().toBuffer()
          return Math.max(...[0, 204, 136].map((channel, index) => Math.abs(pixel[index] - channel)))
        }, { message: `webview renders the page at zoom ${zoom}` }).toBeLessThanOrEqual(2)
      }
      await page.mouse.click(x, y)
      await expect.poll(() => app.evaluate(async ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.clicked || 0'), guestId), {
        message: `native click reaches the page at zoom ${zoom}`,
      }).toBeGreaterThan(index)
    }
    if (smoke) return

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
  } finally {
    server.close()
    await closeApp(app)
  }
})

test('a parked browser defers its first load until it is shown or requested', async () => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url!)
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<title>Deferred page</title><button>Ready</button>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { electronApp: app, mainWindow: page } = await launchApp()
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test web server has no port')
    const origin = `http://127.0.0.1:${address.port}`
    const workspaceId = (await page.evaluate(() => window.__cateE2E!.selectedWorkspaceId()))!
    const manualUrl = origin + '/manual'
    const automatedUrl = origin + '/automated'
    const manual = await create(page, 'browser', { x: 6_000, y: 120 }, { url: manualUrl })
    const automated = await create(page, 'browser', { x: 8_000, y: 120 }, { url: automatedUrl })
    for (const [panelId, url] of [[manual.panelId, manualUrl], [automated.panelId, automatedUrl]]) {
      const surface = page.locator(`[data-browser-surface="${panelId}"]`)
      await expect(surface.getByPlaceholder('Enter a URL')).toHaveValue(url)
      await expect(surface).toHaveAttribute('data-browser-surface-visible', 'false')
      await expect(surface.locator('webview')).toHaveCount(0)
    }
    expect(requests).toEqual([])

    const browser = { panelId: automated.panelId, workspaceId }
    await expect(browserInvoke(page, browser, 'getAXState')).resolves.toMatchObject({
      ok: true,
      result: { state: expect.stringContaining('button "Ready"') },
    })
    expect(requests.filter(url => url === '/automated')).toHaveLength(1)
    expect(requests).not.toContain('/manual')

    await page.evaluate(id => window.__cateE2E!.moveNode(id, { x: 120, y: 120 }), manual.nodeId)
    await expect.poll(() => requests.filter(url => url === '/manual')).toHaveLength(1)
    await expect.poll(() => browserWebContentsId(page, manual.panelId)).not.toBeNull()
  } finally {
    await closeApp(app)
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
