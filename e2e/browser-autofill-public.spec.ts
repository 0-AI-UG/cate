import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { launchApp, closeApp } from './fixtures/electron-app'
import { act, inspectFixture } from './fixtures/browser-control'

// Opt-in real-site test. Credentials are synthetic and confined to an isolated
// Cate profile; the login form is never submitted.
test('positions and selects autofill on Open CLI Deployment', async () => {
  test.skip(!process.env.E2E_PUBLIC, 'Requires access to the public login page')
  const userDataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cate-ocd-autofill-')))
  let app: ElectronApplication | undefined
  try {
    const launched = await launchApp({ userDataDir })
    app = launched.electronApp
    const page = launched.mainWindow
    const browser = await page.evaluate(async () => {
      await window.electronAPI.browserCredentialSave({
        origin: 'https://ocd.cero-ai.com', username: 'cate-autofill-e2e', password: 'synthetic-autofill-test',
      })
      return window.__cateE2E!.createBrowser('https://ocd.cero-ai.com/#/login', { x: 180, y: 120 })
    })
    await expect.poll(async () => {
      const result = await act(page, browser, 'click', 'PASSWORD', {}, 'textbox')
      return result.ok ? 'clicked' : result.error
    }, { message: 'Click the settled public-site password field' }).toBe('clicked')
    const surface = page.locator(`[data-browser-surface="${browser.panelId}"]`)
    const popup = surface.locator('[data-browser-autofill]')
    await expect(popup).toBeVisible()
    const guest = surface.locator('webview').first()
    const field = await inspectFixture(app, page, browser, 'JSON.parse(JSON.stringify(document.querySelector("input[type=password]").getBoundingClientRect()))')
    const box = (await guest.boundingBox())!
    const width = await guest.evaluate((element) => (element as HTMLElement).offsetWidth)
    const factor = box.width / width
    const popupBox = (await popup.boundingBox())!
    expect(Math.abs(popupBox.x - (box.x + field.result.value.left * factor))).toBeLessThan(3)
    expect(Math.abs(popupBox.y - (box.y + field.result.value.bottom * factor + 6 * factor))).toBeLessThan(3)
    await popup.getByRole('button', { name: /cate-autofill-e2e/ }).click()
    await expect.poll(() => inspectFixture(app!, page, browser, 'document.querySelector("input[type=password]").value'))
      .toMatchObject({ result: { value: 'synthetic-autofill-test' } })
    await expect.poll(() => inspectFixture(app!, page, browser, 'Array.from(document.querySelectorAll("input")).some(input => input.value === "cate-autofill-e2e")'))
      .toMatchObject({ result: { value: true } })
    await expect(page.locator('[data-browser-autofill]')).toBeHidden()
  } finally {
    if (app) await closeApp(app)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
