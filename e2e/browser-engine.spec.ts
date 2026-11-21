import sharp from 'sharp'
import { writeFileSync } from 'node:fs'
import { copyElectronForColdGpuCache } from './fixtures/cold-electron'
import { rmSync } from 'node:fs'
import { measureCanvasPan } from './fixtures/canvas-pan-profile'
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './fixtures/electron-app'
import './fixtures/browser-engine'
import { create, installPerfHelpers } from './fixtures/perf-helpers'

test('isolated browser paints and accepts input inside Cate', async () => {
  const { electronApp: app, mainWindow: page } = await launchApp({ onWindow: async page => { page.on('pageerror', error => console.log('PAGE_ERROR', error.message)); page.on('console', message => { if (message.type() === 'error') console.log('PAGE_CONSOLE', message.text()) }) } })
  try {
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus() })
    await installPerfHelpers(page)
    const html = '<style>body{background:#00cc88}button{width:250px;height:100px}</style><form onsubmit="window.submitted=(window.submitted||0)+1;return false"><button type="button" onclick="this.textContent=\'Clicked\'">Click me</button><input aria-label="Text"></form><input type="password" aria-label="Password"><select aria-label="Choice" onchange="window.selectTrusted=event.isTrusted"><option value="a">Alpha</option><option value="b">Beta</option></select>'
    const { panelId } = await create(page, 'browser', { x: 100, y: 100 }, { url: `data:text/html,${encodeURIComponent(html)}` })
    const canvas = page.locator(`[data-browser-surface="${panelId}"] [data-browser-engine]`)
    await expect.poll(async () => ({ error: await canvas.getAttribute('data-browser-engine-error'), visible: await canvas.isVisible() }), { timeout: 10000 }).toEqual({ error: null, visible: true })
    await expect.poll(async () => Number(await canvas.getAttribute('data-browser-frames'))).toBeGreaterThan(0)
    await page.screenshot({ path: test.info().outputPath('engine-surface.png') })
    const capture = await canvas.screenshot()
    const size = await sharp(capture).metadata()
    const pixel = await sharp(capture).extract({ left: Math.floor(size.width! * .8), top: Math.floor(size.height! * .7), width: 1, height: 1 }).removeAlpha().raw().toBuffer()
    expect(Math.max(...[...pixel].map((value, index) => Math.abs(value - [0, 204, 136][index])))).toBeLessThanOrEqual(2)
    await page.locator('[data-unfocused-overlay]').click()
    await expect(page.locator(`[data-browser-surface="${panelId}"]`)).toHaveCSS('pointer-events', 'auto')
    const bounds = (await canvas.boundingBox())!
    await page.mouse.click(bounds.x + 50, bounds.y + 40)
    const id = Number(await canvas.getAttribute('data-browser-engine'))
    const frameScale = await app.evaluate((_, id) => globalThis.__cateBrowserEngineTest.call<number>('evaluate', { id, script: 'devicePixelRatio' }), id)
    await expect.poll(() => canvas.evaluate(el => (el as HTMLCanvasElement).width / el.clientWidth)).toBeCloseTo(frameScale, 2)
    await expect.poll(() => app.evaluate(async (_, id) => globalThis.__cateBrowserEngineTest.call('evaluate', { id, script: 'document.querySelector("button").textContent' }), id)).toBe('Clicked')
    await page.screenshot({ path: test.info().outputPath('engine-clicked.png') })
    const inputPoint = await app.evaluate((_, id) => globalThis.__cateBrowserEngineTest.call<{ x: number; y: number }>('evaluate', { id, script: '(() => { const r=document.querySelector("input").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2} })()' }), id)
    const dimensions = await canvas.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }))
    await page.mouse.click(bounds.x + inputPoint.x * bounds.width / dimensions.width, bounds.y + inputPoint.y * bounds.height / dimensions.height)
    await page.keyboard.type('Hello')
    await page.keyboard.insertText(' Grüße 日本語')
    await expect.poll(() => app.evaluate(async (_, id) => globalThis.__cateBrowserEngineTest.call('evaluate', { id, script: 'document.querySelector("input").value' }), id)).toBe('Hello Grüße 日本語')
    await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('[data-browser-input]')!
      input.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
      input.dispatchEvent(new CompositionEvent('compositionupdate', { data: '中文' }))
      input.dispatchEvent(new CompositionEvent('compositionend', { data: '中文' }))
      input.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: '中文' }))
    })
    await expect.poll(() => app.evaluate(async (_, id) => globalThis.__cateBrowserEngineTest.call('evaluate', { id, script: 'document.querySelector("input").value' }), id)).toBe('Hello Grüße 日本語中文')
    await page.keyboard.press('Enter')
    await expect.poll(() => app.evaluate(async (_, id) => globalThis.__cateBrowserEngineTest.call('evaluate', { id, script: 'window.submitted' }), id)).toBe(1)
    const primary = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${primary}+A`)
    await page.keyboard.type('Replaced')
    await app.evaluate(({ clipboard }) => clipboard.writeText(' pasted'))
    await page.keyboard.press(`${primary}+V`)
    await expect.poll(() => app.evaluate((_, id) => globalThis.__cateBrowserEngineTest.call('evaluate', { id, script: 'document.querySelector("input").value' }), id)).toBe('Replaced pasted')
    const clickField = async (selector: string) => {
      const point = await app.evaluate((_, { id, selector }) => globalThis.__cateBrowserEngineTest.call<{ x: number; y: number }>('evaluate', { id, script: `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2} })()` }), { id, selector })
      await page.mouse.click(bounds.x + point.x * bounds.width / dimensions.width, bounds.y + point.y * bounds.height / dimensions.height)
    }
    await clickField('input[type=password]')
    await expect(page.locator('[data-browser-secure-input]')).toBeFocused()
    await page.keyboard.type('Secret')
    await expect.poll(() => app.evaluate((_, id) => globalThis.__cateBrowserEngineTest.call('evaluate', { id, script: 'document.querySelector("input[type=password]").value' }), id)).toBe('Secret')
    await clickField('select')
    await page.screenshot({ path: test.info().outputPath('engine-select.png') })
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect.poll(() => app.evaluate((_, id) => globalThis.__cateBrowserEngineTest.call('evaluate', { id, script: 'document.querySelector("select").value' }), id)).toBe('b')
    await expect.poll(() => app.evaluate((_, id) => globalThis.__cateBrowserEngineTest.call('evaluate', { id, script: 'window.selectTrusted' }), id)).toBe(true)
    await clickField('select')
    await expect.poll(() => app.evaluate((_, id) => globalThis.__cateBrowserEngineTest.call('evaluate', { id, script: 'document.querySelector("select").matches(":open")' }), id)).toBe(true)
    await clickField('option[value=a]')
    await expect.poll(() => app.evaluate((_, id) => globalThis.__cateBrowserEngineTest.call('evaluate', { id, script: 'document.querySelector("select").value' }), id)).toBe('a')

  } finally { await closeApp(app) }
})

test('zoomed-out browsers use 1× frames without recreating the page on zoom', async () => {
  const { electronApp: app, mainWindow: page } = await launchApp()
  try {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show() })
    await page.evaluate(() => window.__cateE2E!.setZoom(.55))
    const { panelId } = await create(page, 'browser', { x: 100, y: 100 }, { url: 'data:text/html,<h1>Ready</h1>' })
    const canvas = page.locator(`[data-browser-surface="${panelId}"] [data-browser-engine]`)
    await expect.poll(async () => Number(await canvas.getAttribute('data-browser-frames'))).toBeGreaterThan(0)
    const id = await canvas.getAttribute('data-browser-engine')
    const density = () => canvas.evaluate(el => (el as HTMLCanvasElement).width / el.clientWidth)
    await expect.poll(density).toBeCloseTo(1, 2)
    await page.evaluate(() => window.__cateE2E!.setZoom(1))
    await expect(canvas).toHaveAttribute('data-browser-engine', id!)
    await expect.poll(density).toBeCloseTo(1, 2)

    const second = await create(page, 'browser', { x: 120, y: 120 }, { url: 'data:text/html,<h1>New page</h1>' })
    const larger = page.locator(`[data-browser-surface="${second.panelId}"] [data-browser-engine]`)
    await expect.poll(async () => Number(await larger.getAttribute('data-browser-frames'))).toBeGreaterThan(0)
    const dpr = await page.evaluate(() => devicePixelRatio)
    // The default compact browser viewport uses a 75% display scale.
    const expectedDensity = Math.max(1, Math.min(4, dpr, Math.round(dpr * .75 * 2) / 2))
    const largerId = Number(await larger.getAttribute('data-browser-engine'))
    const reportedDensity = await app.evaluate((_, id) => globalThis.__cateBrowserEngineTest.call<number>('evaluate', { id, script: 'devicePixelRatio' }), largerId)
    const scale = await larger.evaluate(el => el.getBoundingClientRect().width / el.clientWidth)
    expect(reportedDensity, `canvas display scale: ${scale}`).toBeCloseTo(expectedDensity, 2)
    await expect.poll(() => larger.evaluate(el => (el as HTMLCanvasElement).width / el.clientWidth)).toBeCloseTo(expectedDensity, 2)
  } finally { await closeApp(app) }
})


test('real sites stream inside Cate without holding canvas frames', async () => {
  test.skip(process.env.CATE_ENGINE_PROFILE !== '1', 'Opt-in visible real-site profile')
  test.setTimeout(180_000)
  const cold = process.env.CATE_ENGINE_COLD === '1' ? copyElectronForColdGpuCache(require('electron') as string) : undefined
  const { electronApp: app, mainWindow: page } = await launchApp({ executablePath: cold?.executablePath,  })
  const rows: unknown[] = []
  try {
    await app.evaluate(async ({ app, BrowserWindow }) => { if (process.platform === 'darwin') app.setActivationPolicy('regular'); await app.dock?.show(); const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 950); w.show(); app.show(); app.focus({ steal: true }); w.focus() })
    await installPerfHelpers(page)
    if (process.env.CATE_ENGINE_TRACE) await app.evaluate(async ({ contentTracing }) => contentTracing.startRecording({ included_categories: ['cc', 'gpu', 'viz', 'devtools.timeline', 'toplevel', 'skia', 'disabled-by-default-skia.gpu', 'disabled-by-default-gpu.service', 'disabled-by-default-gpu.dawn'] }))
    const { panelId } = await create(page, 'browser', { x: 100, y: 100 }, { url: 'data:text/html,<h1>Ready</h1>' })
    const canvas = page.locator(`[data-browser-surface="${panelId}"] [data-browser-engine]`)
    await expect(canvas).toBeVisible({ timeout: 30000 })
    await expect.poll(async () => Number(await canvas.getAttribute('data-browser-frames'))).toBeGreaterThan(0)
    await page.evaluate(() => { window.__cateE2E!.setZoom(.8); window.__cateE2E!.resetViewport() })
    rows.push({ mode: 'baseline', ...await measureCanvasPan(page) })
    if (process.env.CATE_ENGINE_NO_CHROME === '1') await page.evaluate(() => {
      for (const type of ['dom-ready', 'did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) document.addEventListener(type, event => { if ((event.target as HTMLElement)?.dataset.browserEngine) event.stopImmediatePropagation() }, true)
    })
    for (const url of ['https://github.com/microsoft/vscode/issues', 'https://en.wikipedia.org/wiki/Electron_(software_framework)', 'https://www.electronjs.org/docs/latest/api/webview-tag', 'https://www.bbc.com/news']) {
      await page.evaluate(() => window.__cateE2E!.resetViewport())
      await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus() })
      const before = Number(await canvas.getAttribute('data-browser-frames'))
      const movement = measureCanvasPan(page)
      await page.waitForFunction(() => window.__isolationPanning)
      await canvas.evaluate((element, url) => (element as unknown as { loadURL(url: string): Promise<void> }).loadURL(url), url)
      const gesture = await movement
      const after = Number(await canvas.getAttribute('data-browser-frames'))
      const focused = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())
      const content = await app.evaluate((_, id) => globalThis.__cateBrowserEngineTest.call<{ title: string; url: string }>('evaluate', { id, script: '({title:document.title,url:location.href})' }), Number(await canvas.getAttribute('data-browser-engine')))
      rows.push({ url, focused, title: content.title, actualUrl: content.url, paintedFrames: after - before, ...gesture })
      console.log('ENGINE_PROFILE', JSON.stringify(rows.at(-1)))
      writeFileSync(process.env.CATE_ENGINE_OUTPUT ?? test.info().outputPath('engine-profile.json'), JSON.stringify(rows, null, 2))
      expect(content.url).toBe(url)
      expect(content.title).toMatch(/GitHub|Wikipedia|Electron|BBC/)
      expect.soft(gesture.p99).toBeLessThan(25)
      expect.soft(gesture.max).toBeLessThan(60)
      expect(gesture.transformChanged).toBe(true)
      expect(after).toBeGreaterThan(before)
      if (process.env.CATE_ENGINE_CAPTURE === '1') await page.screenshot({ path: test.info().outputPath(`engine-${rows.length}.png`) })
    }
  } finally { if (process.env.CATE_ENGINE_TRACE) await app.evaluate(async ({ contentTracing }, path) => contentTracing.stopRecording(path), process.env.CATE_ENGINE_TRACE); await closeApp(app); if (cold) rmSync(cold.root, { recursive: true, force: true }) }
})


test('engine faults and parent exit leave no helper or native error dialog', async () => {
  let exited = false
  const { electronApp: app, mainWindow: page, home } = await launchApp({})
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  try {
    await create(page, 'browser', { x: 100, y: 100 }, { url: 'data:text/html,<h1>Lifecycle</h1>' })
    await expect(page.locator('[data-browser-engine]')).toHaveCount(1)
    const oldId = Number(await page.locator('[data-browser-engine]').getAttribute('data-browser-engine'))
    const state = await app.evaluate(() => globalThis.__cateBrowserEngineTest.call<{ pid: number; metrics: Array<{ type: string; pid: number }> }>('inspect', {}))
    const parentGpu = await app.evaluate(({ app }) => app.getAppMetrics().find(metric => metric.type === 'GPU')?.pid)
    const browserGpu = state.metrics.find(metric => metric.type === 'GPU')?.pid
    expect(parentGpu).toBeTruthy()
    expect(browserGpu).toBeTruthy()
    expect(browserGpu).not.toBe(parentGpu)
    await app.evaluate(() => globalThis.__cateBrowserEngineTest.call('crash', {})).catch(() => {})
    await expect.poll(() => alive(state.pid), { timeout: 5000 }).toBe(false)
    expect(await page.evaluate(() => window.__cateE2E!.ready)).toBe(true)
    const overlay = page.locator('[data-unfocused-overlay]')
    if (await overlay.isVisible()) await overlay.click()
    await page.getByRole('button', { name: 'Reload Page', exact: true }).click()
    await expect.poll(async () => Number(await page.locator('[data-browser-engine]').getAttribute('data-browser-engine'))).toBeGreaterThan(oldId)
    const newId = Number(await page.locator('[data-browser-engine]').getAttribute('data-browser-engine'))
    await page.evaluate(id => window.cateBrowserEngine!.close(id), oldId)
    await expect.poll(() => app.evaluate((_, id) => globalThis.__cateBrowserEngineTest.call('evaluate', { id, script: 'document.body.innerText' }), newId)).toContain('Lifecycle')
    // A fresh engine is also tied to its parent's control channel, even if
    // Electron exits immediately instead of running its normal quit hooks.
    const restarted = await app.evaluate(() => globalThis.__cateBrowserEngineTest.call<{ pid: number }>('inspect', {}))
    expect(alive(restarted.pid)).toBe(true)
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    exited = true
    await expect.poll(() => alive(restarted.pid), { timeout: 5000 }).toBe(false)
  } finally { await closeApp(exited ? undefined : app, { home }) }
})

test('surface transport rejects a client without its connection secret', async () => {
  const { electronApp: app, mainWindow: page } = await launchApp()
  try {
    await create(page, 'browser', { x: 100, y: 100 }, { url: 'data:text/html,Private page' })
    await expect(page.locator('[data-browser-engine]')).toHaveCount(1)
    const result = await page.evaluate(async () => {
      const partition = document.querySelector('[data-browser-partition]')!.getAttribute('data-browser-partition')!
      const connection = await window.cateBrowserEngine!.create({ partition, panelId: 'transport-test', tabId: 'transport-test', url: 'data:text/html,Protected', width: 200, height: 100, scaleFactor: devicePixelRatio })
      try {
        return await new Promise<{ code: number; messages: number }>((resolve, reject) => {
          const socket = new WebSocket(connection.url, 'incorrect-connection-secret')
          let messages = 0
          socket.onmessage = () => { messages++ }
          socket.onclose = event => { clearTimeout(timer); resolve({ code: event.code, messages }) }
          const timer = setTimeout(() => { socket.close(); reject(new Error('Unauthenticated stream did not close')) }, 3000)
        })
      } finally { await window.cateBrowserEngine!.close(connection.id) }
    })
    expect(result).toEqual({ code: 1008, messages: 0 })
    expect(await app.evaluate(() => globalThis.__cateBrowserEngineTest.isRunning())).toBe(true)
  } finally { await closeApp(app) }
})
