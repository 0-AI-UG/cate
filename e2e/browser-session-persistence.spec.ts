import { browserInvoke, target, act, inspectFixture } from './fixtures/browser-control'
import { once } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp } from './fixtures/electron-app'

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
  const userDataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cate-browser-session-')))
  let app: ElectronApplication | undefined
  try {
    let launched = await launchApp({ userDataDir })
    app = launched.electronApp
    let page = launched.mainWindow
    const login = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), `${origin}/login`)
    await expect.poll(() => browserInvoke(page, login, 'getTab'), { timeout: 20_000 })
      .toMatchObject({ ok: true, result: { url: `${origin}/login` } })
    await expect(inspectFixture(app!, page, login, "document.querySelector(\"#email\")?.getAttribute(\"id\")")).resolves
      .toMatchObject({ ok: true, result: { value: 'email' } })
    await expect(act(page, login, 'setValue', "Email", { value: 'session@example.test' })).resolves.toMatchObject({ ok: true })
    await expect(act(page, login, 'setValue', "Password", { value: 'persistent secret' })).resolves.toMatchObject({ ok: true })
    await expect(act(page, login, 'click', "Sign in", {}, 'button')).resolves.toMatchObject({ ok: true })
    await expect.poll(() => inspectFixture(app!, page, login, "document.querySelector(\"h1\")?.textContent ?? ''", 'text'), { timeout: 20_000 })
      .toMatchObject({ ok: true, result: { text: 'Persistent session' } })

    const secondPanel = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 760, y: 100 }), `${origin}/account`)
    await expect.poll(() => inspectFixture(app!, page, secondPanel, "document.querySelector(\"h1\")?.textContent ?? ''", 'text'), { timeout: 20_000 })
      .toMatchObject({ ok: true, result: { text: 'Persistent session' } })

    await closeApp(app)
    app = undefined

    launched = await launchApp({ userDataDir })
    app = launched.electronApp
    page = launched.mainWindow
    const afterRestart = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), `${origin}/account`)
    await expect.poll(() => inspectFixture(app!, page, afterRestart, "document.querySelector(\"h1\")?.textContent ?? ''", 'text'), { timeout: 20_000 })
      .toMatchObject({ ok: true, result: { text: 'Persistent session' } })
  } finally {
    if (app) await closeApp(app)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('lists a saved password and autofills username and password without exposing the secret to the host UI', async () => {
  const userDataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cate-browser-password-')))
  let app: ElectronApplication | undefined
  try {
    const launched = await launchApp({ userDataDir })
    app = launched.electronApp
    const page = launched.mainWindow
    const credentialStorageAvailable = await app.evaluate(({ safeStorage }) =>
      safeStorage.isEncryptionAvailable()
      && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'))
    test.skip(!credentialStorageAvailable, 'Secure credential storage is unavailable in this environment')
    const encryptedPassword = await app.evaluate(({ safeStorage }, password) =>
      safeStorage.encryptString(password).toString('base64'), 'autofill secret')
    const credentialId = '11111111-1111-4111-8111-111111111111'
    writeFileSync(path.join(userDataDir, 'browser-credentials.json'), JSON.stringify({
      version: 1,
      credentials: [{
        id: credentialId,
        origin,
        signonRealm: origin,
        username: 'saved@example.test',
        usernameElement: 'email',
        passwordElement: 'password',
        encryptedPassword,
        importedAt: Date.now(),
      }],
    }), { mode: 0o600 })

    const browser = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), `${origin}/login`)
    const webContentsId = await expect.poll(
      () => page.evaluate((panelId) => window.__cateE2E!.browserWebContentsId(panelId), browser.panelId),
      { timeout: 20_000 },
    ).not.toBeNull().then(() => page.evaluate(
      (panelId) => window.__cateE2E!.browserWebContentsId(panelId), browser.panelId,
    ))
    await expect(inspectFixture(app!, page, browser, 'document.querySelector("#password").focus(); true')).resolves.toMatchObject({ ok: true })
    const target = await inspectFixture(app!, page, browser, "document.querySelector(\"#password\")?.getAttribute(\"data-cate-autofill-target\")") as {
      ok: boolean
      result: { value: string }
    }
    expect(target.result.value).toMatch(/^[0-9a-f-]{36}$/i)

    const suggestions = await page.evaluate((id) => window.electronAPI.browserCredentialSuggestions(id!), webContentsId)
    expect(suggestions.suggestions).toEqual([{
      id: credentialId,
      origin,
      username: 'saved@example.test',
    }])
    await expect(page.evaluate(({ webContentsId, credentialId, targetId }) =>
      window.electronAPI.browserCredentialFill({ webContentsId: webContentsId!, credentialId, targetId }), {
      webContentsId,
      credentialId,
      targetId: target.result.value,
    })).resolves.toMatchObject({ ok: true })
    await expect(inspectFixture(app!, page, browser, "document.querySelector(\"#email\")?.value")).resolves
      .toMatchObject({ ok: true, result: { value: 'saved@example.test' } })
    await expect(inspectFixture(app!, page, browser, 'document.querySelector("#password").value')).resolves.toMatchObject({ ok: true, result: { value: 'autofill secret' } })

    const manager = await page.evaluate(() => window.__cateE2E!.createBrowser(
      'chrome://password-manager/passwords', { x: 760, y: 100 },
    ))
    const managerPage = page.locator(`[data-browser-surface="${manager.panelId}"] [data-browser-password-manager]`)
    await expect(managerPage).toContainText('saved@example.test')
    await expect(managerPage).not.toContainText('autofill secret')
  } finally {
    if (app) await closeApp(app)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
