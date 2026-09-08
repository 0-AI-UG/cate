import { writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp } from './fixtures/electron-app'
import { browserInvoke } from './fixtures/browser-control'

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
    const browser = await page.evaluate(url => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), url)
    await expect.poll(() => browserInvoke(page, browser, 'getTab'), { timeout: 20_000 }).toMatchObject({ ok: true })
    const guestId = await page.evaluate(id => window.__cateE2E!.browserWebContentsId(id), browser.panelId)
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
    for (const method of ['getAXState', 'getScreenshot', 'getAXStateAndScreenshot']) {
      await browserInvoke(page, browser, method, { disableDiffing: true })
      const samples: Array<Record<string, any>> = []
      for (let i = 0; i < 5; i++) {
        await app.evaluate(({ webContents }, id) => { (webContents.fromId(id!)! as any).__observationCalls = [] }, guestId)
        const started = performance.now()
        const result = await browserInvoke(page, browser, method, { disableDiffing: true, profile: true }) as any
        const elapsedMs = performance.now() - started
        expect(result.ok, JSON.stringify(result)).toBe(true)
        const observation = result.result
        expect(JSON.stringify(observation)).not.toContain('never-expose-this-secret')
        if (method !== 'getScreenshot') {
          expect(observation.elements.filter((element: any) => element.role === 'textbox' && element.name.startsWith('Field '))).toHaveLength(500)
          expect(observation.elements.find((element: any) => element.role === 'textbox' && element.name === 'Field 0')?.value).toBe('value-0')
          expect(observation.elements.find((element: any) => element.role === 'textbox' && element.name === 'Field 499')?.value).toBe('••••••••')
          for (const name of ['open shadow button', 'closed shadow button', 'Frame button']) {
            expect(observation.elements.some((element: any) => element.name === name)).toBe(true)
          }
        }
        if (method !== 'getAXState') {
          expect(observation.screenshot.width).toBe(observation.viewport.width)
          expect(observation.screenshot.height).toBe(observation.viewport.height)
        }
        const calls = await app.evaluate(({ webContents }, id) => (webContents.fromId(id!)! as any).__observationCalls as string[], guestId)
        samples.push({ elapsedMs, cdpCalls: calls.length, axCalls: calls.filter(method => method.startsWith('Accessibility.')).length,
          imageBytes: observation.screenshot ? Buffer.from(observation.screenshot.data, 'base64').length : 0,
          phases: observation.performance })
      }
      const sorted = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b)
      reports.push({ method, p50Ms: sorted[2], p95Ms: sorted[4], samples })
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
