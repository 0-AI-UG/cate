import { test, expect } from '@playwright/test'
import { performance } from 'node:perf_hooks'
import { launchApp, closeApp, expectTerminalText } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForPty } from './fixtures/perf-helpers'

test('terminal cold and warm startup reaches an interactive shell', async () => {
  const { electronApp, mainWindow: page } = await launchApp({ perf: true })
  try {
    await installPerfHelpers(page)
    const samples = []
    for (let i = 0; i < 10; i++) {
      const started = performance.now()
      const { panelId, nodeId } = await create(page, 'terminal', { x: 40, y: 40 })
      await page.waitForSelector(`[data-node-id="${nodeId}"] .xterm-screen`)
      const viewMs = performance.now() - started
      await waitForPty(page, panelId)
      const ptyMs = performance.now() - started
      const marker = `TERMINAL_READY_${i}`
      await page.evaluate(({ panelId, marker }) => window.__cateE2E!.writeTerminal(panelId, `printf '%s%s\\n' 'TERMINAL_' 'READY_${marker.split('_').at(-1)}'\n`), { panelId, marker })
      await expectTerminalText(page, panelId, marker)
      const interactiveMs = performance.now() - started
      const closeStarted = performance.now()
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
      await expect(page.locator(`[data-node-id="${nodeId}"]`)).toHaveCount(0)
      samples.push({ iteration: i, viewMs, ptyMs, interactiveMs, closeMs: performance.now() - closeStarted })
    }
    console.table(samples)
    await test.info().attach('terminal-startup.json', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' })
  } finally { await closeApp(electronApp) }
})
