import { writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp } from './fixtures/electron-app'
import { browserInvoke, browserWebContentsId, createBrowser } from './fixtures/browser-control'

test('large-form observations report latency and keep screenshots independent of AX size', async () => {
  const { electronApp: app, mainWindow: page } = await launchApp()
  let server: Server | undefined
  try {
    const html = `<title>Observation performance</title>${Array.from({ length: 500 }, (_, i) =>
      `<label>Field ${i}<input type="${i === 499 ? 'password' : 'text'}" value="${i === 499 ? 'never-expose-this-secret' : `value-${i}`}"></label>`).join('')}
      <div id="open"></div><div id="closed"></div>
      <iframe srcdoc="<button>Frame button</button>"></iframe>
      <script>for(const mode of ['open','closed'])document.getElementById(mode).attachShadow({mode}).innerHTML='<button>'+mode+' shadow button</button>';
      Object.defineProperty(HTMLInputElement.prototype,'type',{get(){return 'password'}})</script>`
    server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html) })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const browser = await createBrowser(page, url, { x: 100, y: 100 })
    await expect.poll(() => browserInvoke(page, browser, 'selectTab'), { timeout: 20_000 }).toMatchObject({ ok: true })
    const guestId = await browserWebContentsId(page, browser.panelId)
    await app.evaluate(({ webContents }, id) => {
      const guest = webContents.fromId(id!)! as any
      const send = guest.debugger.sendCommand.bind(guest.debugger)
      guest.__observationCalls = []
      guest.debugger.sendCommand = (method: string, ...args: unknown[]) => {
        guest.__observationCalls.push(method)
        return send(method, ...args)
      }
    }, guestId)
    const reports: Array<Record<string, any>> = []
    const variants = [
      { name: 'getAXState', method: 'getAXState', tree: true, image: false, extra: {} },
      { name: 'getScreenshot', method: 'getScreenshot', tree: false, image: true, extra: {} },
      { name: 'getAXState --screenshot', method: 'getAXState', tree: true, image: true, extra: { screenshot: true } },
    ]
    for (const { name: label, method, tree, image, extra } of variants) {
      await browserInvoke(page, browser, method, { disableDiffing: true, ...extra })
      const samples: Array<Record<string, any>> = []
      for (let i = 0; i < 5; i++) {
        await app.evaluate(({ webContents }, id) => { (webContents.fromId(id!)! as any).__observationCalls = [] }, guestId)
        const started = performance.now()
        const result = await browserInvoke(page, browser, method, { disableDiffing: true, profile: true, ...extra }) as any
        const elapsedMs = performance.now() - started
        expect(result.ok, JSON.stringify(result)).toBe(true)
        const observation = result.result
        expect(JSON.stringify(observation)).not.toContain('never-expose-this-secret')
        if (tree) {
          expect(observation.elements.filter((element: any) => element.role === 'textbox' && element.name.startsWith('Field '))).toHaveLength(500)
          expect(observation.elements.find((element: any) => element.role === 'textbox' && element.name === 'Field 0')?.value).toBe('value-0')
          expect(observation.elements.find((element: any) => element.role === 'textbox' && element.name === 'Field 499')?.value).toBe('••••••••')
          for (const name of ['open shadow button', 'closed shadow button', 'Frame button']) {
            expect(observation.elements.some((element: any) => element.name === name)).toBe(true)
          }
        }
        if (image) {
          expect(observation.screenshot.width).toBe(observation.viewport.width)
          expect(observation.screenshot.height).toBe(observation.viewport.height)
        }
        const calls = await app.evaluate(({ webContents }, id) => (webContents.fromId(id!)! as any).__observationCalls as string[], guestId)
        samples.push({ elapsedMs, cdpCalls: calls.length, axCalls: calls.filter(method => method.startsWith('Accessibility.')).length,
          imageBytes: observation.screenshot ? Buffer.from(observation.screenshot.data, 'base64').length : 0,
          phases: observation.performance })
      }
      const sorted = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b)
      reports.push({ method: label, p50Ms: sorted[2], p95Ms: sorted[4], samples })
    }
    const reportPath = test.info().outputPath('observation-performance.json')
    await writeFile(reportPath, JSON.stringify(reports, null, 2))
    await test.info().attach('observation-performance', { path: reportPath, contentType: 'application/json' })
    console.log('Browser observation performance', reports.map(({ method, p50Ms, p95Ms, samples }) => ({ method, p50Ms, p95Ms, cdpCalls: samples[0].cdpCalls })))
    const screenshots = reports.find(report => report.method === 'getScreenshot')!
    expect(screenshots.samples.every((sample: any) => sample.axCalls === 0 && sample.cdpCalls < 10)).toBe(true)
    expect(reports.find(report => report.method === 'getAXState')!.samples.every((sample: any) => sample.cdpCalls < 1100)).toBe(true)
  } finally {
    await closeApp(app)
    if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections() })
  }
})

test('screenshots are JPEG with the display colours for an opaque page, PNG for a transparent one', async () => {
  const { electronApp: app, mainWindow: page } = await launchApp()
  let server: Server | undefined
  try {
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<body style="margin:0;${request.url === '/opaque' ? 'background:#fff' : ''}"><div style="margin-left:300px;width:300px;height:200px;background:rgb(20,180,70)"></div>`)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    for (const [path, mimeType] of [['/opaque', 'image/jpeg'], ['/transparent', 'image/png']]) {
      const browser = await createBrowser(page, origin + path, { x: 100, y: 100 })
      await expect.poll(() => browserInvoke(page, browser, 'selectTab'), { timeout: 20_000 }).toMatchObject({ ok: true })
      const result = await browserInvoke(page, browser, 'getScreenshot') as { ok: boolean; result: { screenshot: { mimeType: string; data: string } } }
      expect(result.ok, JSON.stringify(result)).toBe(true)
      expect(result.result.screenshot.mimeType).toBe(mimeType)
      const { data, info } = await sharp(Buffer.from(result.result.screenshot.data, 'base64')).removeAlpha().toColorspace('srgb').raw().toBuffer({ resolveWithObject: true })
      const at = (100 * info.width + 450) * info.channels
      // Native capture passes through the display color profile.
      for (const [channel, expected] of [20, 180, 70].entries()) expect(Math.abs(data[at + channel] - expected)).toBeLessThanOrEqual(5)
    }
  } finally {
    await closeApp(app)
    if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections() })
  }
})
