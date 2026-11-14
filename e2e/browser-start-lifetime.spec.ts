import http from 'node:http'
import { writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { test, expect } from '@playwright/test'
import { launchApp, closeApp, seedOnCanvas } from './fixtures/electron-app'
import { act, browserInvoke, browserWebContentsId, fixtureEvaluate, popupBinding, type BrowserFixture } from './fixtures/browser-control'

test('lazy start guests support first demand, tab switching, reload, history, focus and popups', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    const title = request.url === '/second' ? 'Second' : request.url === '/popup' ? 'Popup' : 'First'
    response.end(`<title>${title}</title><h1>${title}</h1><input aria-label="Draft"><button onclick="window.open('/popup')">Open popup</button>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const { electronApp: app, mainWindow: page } = await launchApp()
  try {
    const { panelId } = await seedOnCanvas(page, 'browser', { x: 120, y: 120 }, { url: 'cate://newtab' })
    const browser: BrowserFixture = { panelId, workspaceId: (await page.evaluate(() => window.__cateE2E!.selectedWorkspaceId()))! }
    const surface = page.locator(`[data-browser-surface="${panelId}"]`)
    await expect(surface.locator('webview')).toHaveCount(process.env.CATE_BROWSER_START_BASELINE ? 1 : 0)
    const focusTarget = page.getByRole('button', { name: /Select tool/ })
    await focusTarget.focus()
    expect(await browserInvoke(page, browser, 'getAXState', { disableDiffing: true })).toMatchObject({ ok: true })
    await expect(focusTarget).toBeFocused()
    const id = await browserWebContentsId(page, panelId)
    expect(id).not.toBeNull()
    expect(await fixtureEvaluate(app, page, browser, 'location.href')).toBe('about:blank')
    expect(await browserInvoke(page, browser, 'reload')).toMatchObject({ ok: true })
    expect(await browserWebContentsId(page, panelId)).toBe(id)
    await expect(focusTarget).toBeFocused()

    const navigate = async (path: string) => {
      await page.evaluate(({ panelId, url }) => window.__cateE2E!.sessionOp(panelId, { kind: 'navigate', input: url }), { panelId, url: origin + path })
      await expect.poll(() => fixtureEvaluate(app, page, browser, 'location.pathname')).toBe(path)
    }
    await navigate('/first')
    await fixtureEvaluate(app, page, browser, `window.kept = 42; const input = document.querySelector('input'); input.value = 'Draft'; input.dispatchEvent(new Event('input', {bubbles:true}));`)
    await page.evaluate(id => window.__cateE2E!.sessionOp(id, { kind: 'newTab' }), panelId)
    await expect(surface.locator('input[placeholder="Enter a URL"]')).toHaveValue('')
    await expect(surface.locator('webview')).toHaveCount(process.env.CATE_BROWSER_START_BASELINE ? 2 : 1)
    await page.evaluate(({ panelId, tabId }) => window.__cateE2E!.sessionOp(panelId, { kind: 'selectTab', tabId }), { panelId, tabId: browser.tabId! })
    await expect.poll(() => fixtureEvaluate(app, page, browser, `[window.kept, document.querySelector('input').value]`)).toEqual([42, 'Draft'])
    expect(await browserWebContentsId(page, panelId)).toBe(id)

    await navigate('/second')
    expect(await browserInvoke(page, browser, 'back')).toMatchObject({ ok: true })
    await expect.poll(() => fixtureEvaluate(app, page, browser, 'document.title')).toBe('First')
    expect(await browserInvoke(page, browser, 'forward')).toMatchObject({ ok: true })
    await expect.poll(() => fixtureEvaluate(app, page, browser, 'document.title')).toBe('Second')
    expect(await browserInvoke(page, browser, 'reload')).toMatchObject({ ok: true })
    await expect.poll(() => fixtureEvaluate(app, page, browser, 'document.title')).toBe('Second')
    expect(await browserWebContentsId(page, panelId)).toBe(id)
    await focusTarget.focus()
    expect(await act(page, browser, 'click', 'Open popup')).toMatchObject({ ok: true })
    const popup = await popupBinding(page, browser, origin + '/popup')
    expect(await browserInvoke(page, popup, 'selectTab', { tabId: popup.tabId })).toMatchObject({ ok: true })
    expect(await fixtureEvaluate(app, page, popup, 'document.title')).toBe('Popup')
    const popupFocus = {
      baseline: Boolean(process.env.CATE_BROWSER_START_BASELINE),
      popupFocusPreserved: await focusTarget.evaluate(element => element === document.activeElement),
      activeElement: await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') })),
    }
    writeFileSync(test.info().outputPath('start-lifetime-focus.json'), JSON.stringify(popupFocus, null, 2))
    // Existing HEAD behavior: switching a focused browser panel to its popup
    // focuses the guest. Page operations on that tab must still give host focus back.
    expect(popupFocus.activeElement.tag).toBe('WEBVIEW')
    await focusTarget.focus()
    expect(await browserInvoke(page, popup, 'getAXState')).toMatchObject({ ok: true })
    await expect(focusTarget).toBeFocused()
    expect(await browserInvoke(page, browser, 'selectTab', { tabId: browser.tabId })).toMatchObject({ ok: true })
    expect(await browserWebContentsId(page, panelId)).toBe(id)
    // Tab selection schedules guest focus on the next animation frame. Wait
    // for that transition before testing a separate host-focus interaction.
    await expect.poll(() => page.evaluate(id => {
      const active = document.activeElement as (HTMLElement & { getWebContentsId?(): number }) | null
      return active?.tagName === 'WEBVIEW' && active.getWebContentsId?.() === id
    }, id)).toBe(true)
    await focusTarget.focus()
    expect(await browserInvoke(page, browser, 'getAXState')).toMatchObject({ ok: true })
    await expect(focusTarget).toBeFocused()
  } finally {
    await closeApp(app)
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
