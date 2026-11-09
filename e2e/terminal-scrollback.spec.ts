import { test, expect } from '@playwright/test'
import { launchApp, closeApp, expectTerminalText } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForPty } from './fixtures/perf-helpers'

test('terminal history follows workspace limits and survives view remounts', async () => {
  const { electronApp: app, mainWindow: page } = await launchApp({ domTerminals: true })
  try {
    await installPerfHelpers(page)
    const { panelId, nodeId } = await create(page, 'terminal', { x: 30, y: 30 })
    await waitForPty(page, panelId)
    const terminal = page.locator(`[data-node-id="${nodeId}"] .xterm`)
    const oldestVisibleMatchesRuntime = async () => {
      const text = await page.evaluate(id => window.__cateE2E!.terminalText(id), panelId)
      const oldest = text.match(/SCROLL-\d+/)?.[0]
      expect(oldest).toBeTruthy()
      await expect.poll(async () => {
        await terminal.locator('.xterm-viewport').evaluate(async e => {
          e.scrollTop = e.scrollHeight
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
          e.scrollTop = 0
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        })
        return terminal.locator('.xterm-rows').textContent()
      }).toContain(oldest!)
      return Number(oldest!.slice('SCROLL-'.length))
    }
    await page.evaluate(id => window.__cateE2E!.writeTerminal(id, "printf 'SCROLL-%05d\\n' {1..10000}; echo SCROLL-'DONE'\n"), panelId)
    await expectTerminalText(page, panelId, 'SCROLL-DONE')
    expect(await oldestVisibleMatchesRuntime()).toBeGreaterThan(7900)

    await page.evaluate(() => window.__cateE2E!.call('settings', 'set', { key: 'terminalScrollback', value: 5000 }))
    await page.evaluate(id => window.__cateE2E!.writeTerminal(id, "printf 'SCROLL-%05d\\n' {10001..20000}; echo SCROLL-'SECOND-DONE'\n"), panelId)
    await expectTerminalText(page, panelId, 'SCROLL-SECOND-DONE')
    expect(await oldestVisibleMatchesRuntime()).toBeLessThan(15100)

    await page.evaluate(() => window.__cateE2E!.setViewport({ x: -20000, y: -20000 }))
    await expect(terminal).toHaveCount(0)
    await page.evaluate(() => window.__cateE2E!.setViewport({ x: 0, y: 0 }))
    await expect(terminal).toHaveCount(1)
    expect(await oldestVisibleMatchesRuntime()).toBeLessThan(15100)

    await page.evaluate(() => window.__cateE2E!.call('settings', 'set', { key: 'terminalScrollback', value: 500 }))
    expect(await oldestVisibleMatchesRuntime()).toBeGreaterThan(19400)
  } finally { await closeApp(app) }
})
