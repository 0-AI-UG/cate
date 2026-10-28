import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp } from './fixtures/electron-app'
import { browserWebContentsId, createBrowser } from './fixtures/browser-control'

let app: ElectronApplication
let page: Page
let server: Server
let origin: string
let proxyPort: number
let sockets: WebSocketServer
const authorizedRequests: string[] = []

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/proxy.pac') {
      res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig' })
      res.end(`function FindProxyForURL(url, host) { return host === 'native-browser.invalid' ? 'PROXY 127.0.0.1:${proxyPort}' : 'DIRECT'; }`)
    } else if (req.url?.startsWith('http://native-browser.invalid/')) {
      if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('cate-test:secret').toString('base64')}`) {
        res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="browser-test"' }).end()
        return
      }
      authorizedRequests.push(req.url)
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Native proxy</title><h1>Proxied</h1>')
    } else {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Native loopback</title><h1>Loopback</h1>')
    }
  })
  sockets = new WebSocketServer({ server })
  sockets.on('connection', (socket) => socket.on('message', (data) => socket.send(String(data))))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  proxyPort = (server.address() as AddressInfo).port
  origin = `http://127.0.0.1:${proxyPort}`
})

test.afterAll(async () => {
  for (const socket of sockets.clients) socket.terminate()
  sockets.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('preserves loopback HTTP and WebSockets and blocks private targets after protected routing is required', async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  const browser = await createBrowser(page, origin)
  const id = (await browserWebContentsId(page, browser.panelId))!
  const echo = () => app.evaluate(async ({ webContents }, { id, url }) => {
    return webContents.fromId(id)!.executeJavaScript(`new Promise((resolve, reject) => {
      const socket = new WebSocket(${JSON.stringify(url)});
      socket.onopen = () => socket.send('echo');
      socket.onmessage = event => { resolve(event.data); socket.close(); };
      socket.onerror = () => reject(new Error('WebSocket failed'));
    })`)
  }, { id, url: origin.replace('http:', 'ws:') })
  expect(await echo()).toBe('echo')

  // Exercise the real protected policy and renderer loopback bridge without
  // depending on pairing or the availability of a second machine.
  await page.evaluate(async (workspaceId) => {
    const info = await window.__cateE2E!.call('workspace', 'info', {}, workspaceId) as { runtimeId: string }
    await window.cateDesktop.web.partitionFor({ runtimeId: info.runtimeId, reachesClientNetwork: false })
  }, browser.workspaceId)
  const route = await app.evaluate(({ webContents }, { id, url }) => webContents.fromId(id)!.session.resolveProxy(url), { id, url: origin })
  expect(route).toMatch(/^PROXY 127\.0\.0\.1:\d+$/)
  await app.evaluate(({ webContents }, { id, url }) => webContents.fromId(id)!.loadURL(url), { id, url: `${origin}/protected` })
  expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getTitle(), id)).toBe('Native loopback')
  expect(await echo()).toBe('echo')
  const privateStatus = await app.evaluate(async ({ webContents }, id) => {
    const response = await webContents.fromId(id)!.session.fetch('http://192.168.1.1:12345/')
    return response.status
  }, id)
  expect(privateStatus).toBe(403)
})

test.afterEach(async () => { if (app) await closeApp(app) })

test('uses Chromium system networking and applies authenticated proxy and PAC settings live', async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  const browser = await createBrowser(page, origin)
  const id = (await browserWebContentsId(page, browser.panelId))!
  const title = () => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getTitle(), id)
  const resolveProxy = (url: string) => app.evaluate(({ webContents }, { id, url }) => webContents.fromId(id)!.session.resolveProxy(url), { id, url })
  const navigate = (url: string) => app.evaluate(({ webContents }, { id, url }) => webContents.fromId(id)!.loadURL(url), { id, url })
  const setProxy = (value: string) => page.evaluate(async (value) => {
    const settings = await window.cateDesktop.device.get('settings')
    await window.cateDesktop.device.set('settings', { ...settings, browserProxyUrl: value })
  }, value)

  await expect.poll(title).toBe('Native loopback')
  // Compare with the untouched system session: ordinary sites must not be
  // routed through a Cate-owned loopback proxy.
  const system = await app.evaluate(({ session }) => session.defaultSession.resolveProxy('https://google.de'))
  expect(await resolveProxy('https://google.de')).toBe(system)

  await setProxy(`http://cate-test:secret@127.0.0.1:${proxyPort}`)
  await expect.poll(() => resolveProxy('http://native-browser.invalid/auth')).toBe(`PROXY 127.0.0.1:${proxyPort}`)
  await navigate('http://native-browser.invalid/auth')
  await expect.poll(title).toBe('Native proxy')
  expect(authorizedRequests).toContain('http://native-browser.invalid/auth')

  await setProxy(`${origin}/proxy.pac`)
  // Chromium fetches and compiles the PAC asynchronously after setProxy.
  await expect.poll(() => resolveProxy('http://native-browser.invalid/pac'), { timeout: 15_000 }).toBe(`PROXY 127.0.0.1:${proxyPort}`)
  await navigate('http://native-browser.invalid/pac')
  await expect.poll(title).toBe('Native proxy')

  await setProxy('')
  await expect.poll(() => resolveProxy('https://google.de')).toBe(system)
  await navigate(origin)
  await expect.poll(title).toBe('Native loopback')
})
