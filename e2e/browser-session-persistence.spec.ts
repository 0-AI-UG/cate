import { browserInvoke, browserWebContentsId, createBrowser, act, inspectFixture } from './fixtures/browser-control'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp, makeHome, makeProject, seedOnCanvas } from './fixtures/electron-app'

let server: Server
let origin: string

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://session.test')
    if (request.method === 'POST' && url.pathname === '/session') {
      response.writeHead(303, {
        location: '/account',
        'set-cookie': 'cate-persistent-session=active; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax',
      })
      response.end()
      return
    }
    if (url.pathname === '/account') {
      const authenticated = request.headers.cookie?.includes('cate-persistent-session=active') === true
      response.writeHead(authenticated ? 200 : 401, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><title>Account</title><h1>${authenticated ? 'Persistent session' : 'Signed out'}</h1>`)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Login</title><form method="post" action="/session"><label>Email <input id="email" name="email" type="email" autocomplete="username"></label><label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label><button id="login">Sign in</button></form>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})


test('shares cookies across panels and preserves the authenticated session across app restarts', async () => {
  test.setTimeout(90_000)
  // Cookies live in the workspace partition of this device's userData; the
  // relaunch reuses the device, HOME and workspace.
  const home = makeHome()
  const project = makeProject(home)
  const userDataDir = path.join(home, 'device')
  let app: ElectronApplication | undefined
  try {
    let launched = await launchApp({ home, userDataDir, workspace: project })
    app = launched.electronApp
    let page = launched.mainWindow
    const login = await createBrowser(page, `${origin}/login`, { x: 100, y: 100 })
    await expect.poll(() => browserInvoke(page, login, 'getTab'), { timeout: 20_000 })
      .toMatchObject({ ok: true, result: { url: `${origin}/login` } })
    await expect(inspectFixture(app!, page, login, "document.querySelector(\"#email\")?.getAttribute(\"id\")")).resolves
      .toMatchObject({ ok: true, result: { value: 'email' } })
    await expect(act(page, login, 'setValue', "Email", { value: 'session@example.test' })).resolves.toMatchObject({ ok: true })
    await expect(act(page, login, 'setValue', "Password", { value: 'persistent secret' })).resolves.toMatchObject({ ok: true })
    await expect(act(page, login, 'click', "Sign in", {}, 'button')).resolves.toMatchObject({ ok: true })
    await expect.poll(() => inspectFixture(app!, page, login, "document.querySelector(\"h1\")?.textContent ?? ''", 'text'), { timeout: 20_000 })
      .toMatchObject({ ok: true, result: { text: 'Persistent session' } })

    const secondPanel = await createBrowser(page, `${origin}/account`, { x: 760, y: 100 })
    await expect.poll(() => inspectFixture(app!, page, secondPanel, "document.querySelector(\"h1\")?.textContent ?? ''", 'text'), { timeout: 20_000 })
      .toMatchObject({ ok: true, result: { text: 'Persistent session' } })

    await closeApp(app)
    app = undefined

    launched = await launchApp({ home, userDataDir, workspace: project })
    app = launched.electronApp
    page = launched.mainWindow
    const afterRestart = await createBrowser(page, `${origin}/account`, { x: 100, y: 100 })
    await expect.poll(() => inspectFixture(app!, page, afterRestart, "document.querySelector(\"h1\")?.textContent ?? ''", 'text'), { timeout: 20_000 })
      .toMatchObject({ ok: true, result: { text: 'Persistent session' } })
  } finally {
    await closeApp(app, { home })
  }
})

test('lists a saved password and autofills username and password without exposing the secret to the host UI', async () => {
  const launched = await launchApp()
  const app: ElectronApplication = launched.electronApp
  const page: Page = launched.mainWindow
  try {
    // Saved passwords are workspace data in the runtime (secrets.json).
    const saved = await page.evaluate((origin) => window.__cateE2E!.call('browserData', 'savePassword', { input: {
      origin, username: 'saved@example.test', password: 'autofill secret', usernameElement: 'email', passwordElement: 'password',
    } }), origin) as { id?: string; credential?: { id: string } }
    const credentialId = saved.id ?? saved.credential?.id

    const browser = await createBrowser(page, `${origin}/login`, { x: 100, y: 100 })
    const webContentsId = await browserWebContentsId(page, browser.panelId)
    const surface = page.locator(`[data-browser-surface="${browser.panelId}"]`)
    const popup = surface.locator('[data-browser-autofill]')
    // Exercise both canvas transforms and page zoom. Compare the displayed
    // popup against the independently measured field and webview rectangles.
    for (const zoom of [1, 0.75]) {
      await page.evaluate((zoom) => window.__cateE2E!.setZoom(zoom), zoom)
      // Page zoom goes through the panel (the view positions the popup from it).
      await page.evaluate((panelId) => window.__cateE2E!.sessionOp(panelId, { kind: 'setZoom', zoom: 1.2 }), browser.panelId)
      await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id!)!.getZoomFactor(), webContentsId)).toBeCloseTo(1.2)
      await expect(act(page, browser, 'click', 'Email', {}, 'textbox')).resolves.toMatchObject({ ok: true })
      await expect(act(page, browser, 'click', 'Password', {}, 'textbox')).resolves.toMatchObject({ ok: true })
      await expect(popup).toBeVisible()
      const field = await inspectFixture(app, page, browser, 'JSON.parse(JSON.stringify(document.querySelector("#password").getBoundingClientRect()))')
      const rect = field.result.value as { left: number; bottom: number }
      const guest = surface.locator('webview').first()
      const guestBox = (await guest.boundingBox())!
      const guestWidth = await guest.evaluate((element) => (element as HTMLElement).offsetWidth)
      const scale = guestBox.width / guestWidth
      await expect.poll(async () => {
        const box = (await popup.boundingBox())!
        return Math.abs(box.y - (guestBox.y + rect.bottom * 1.2 * scale + 6 * zoom))
      }).toBeLessThan(3)
      const box = (await popup.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(guestBox.x - 1)
      expect(box.x + box.width).toBeLessThanOrEqual(guestBox.x + guestBox.width + 1)
    }
    const target = await inspectFixture(app, page, browser, "document.querySelector(\"#password\")?.getAttribute(\"data-cate-autofill-target\")") as {
      ok: boolean
      result: { value: string }
    }
    expect(target.result.value).toMatch(/^[0-9a-f-]{36}$/i)

    const suggestions = await page.evaluate((url) => window.__cateE2E!.call('browserData', 'passwordSuggestions', { url }), `${origin}/login`)
    expect(suggestions).toEqual([expect.objectContaining({ ...(credentialId ? { id: credentialId } : {}), origin, username: 'saved@example.test' })])
    expect(JSON.stringify(suggestions)).not.toContain('autofill secret')
    await popup.getByRole('button', { name: /saved@example.test/ }).click()
    await expect(popup).toBeHidden()
    await expect.poll(() => inspectFixture(app, page, browser, "document.querySelector(\"#email\")?.value"))
      .toMatchObject({ ok: true, result: { value: 'saved@example.test' } })
    await expect.poll(() => inspectFixture(app, page, browser, 'document.querySelector("#password").value')).toMatchObject({ ok: true, result: { value: 'autofill secret' } })

    const manager = await seedOnCanvas(page, 'browser', { x: 760, y: 100 }, { url: 'chrome://password-manager/passwords' })
    const managerPage = page.locator(`[data-browser-surface="${manager.panelId}"] [data-browser-password-manager]`)
    await expect(managerPage).toContainText('saved@example.test')
    await expect(managerPage).not.toContainText('autofill secret')
  } finally {
    await closeApp(app)
  }
})
