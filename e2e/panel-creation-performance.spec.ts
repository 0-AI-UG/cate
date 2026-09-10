import { performance } from 'node:perf_hooks'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp } from './fixtures/electron-app'

async function elapsed<T>(action: () => Promise<T>, ready: (value: T) => Promise<void>): Promise<number> {
  const started = performance.now()
  const value = await action()
  await ready(value)
  return performance.now() - started
}

test('reports first and warm panel creation latency', async () => {
  let app: ElectronApplication | undefined
  try {
    const launched = await launchApp({ perf: true })
    app = launched.electronApp
    const page: Page = launched.mainWindow

    const editorReady = (nodeId: string) => page.waitForSelector(`[data-node-id="${nodeId}"] .monaco-editor textarea`, { timeout: 15_000 }).then(() => {})
    const firstEditorMs = await elapsed(
      () => page.evaluate(() => window.__cateE2E!.createEditor({ x: 40, y: 40 })),
      editorReady,
    )
    const warmEditorMs = await elapsed(
      () => page.evaluate(() => window.__cateE2E!.createEditor({ x: 760, y: 40 })),
      editorReady,
    )
    const terminalMs = await elapsed(
      () => page.evaluate(() => window.__cateE2E!.createTerminal({ x: 40, y: 580 })),
      async (nodeId) => {
        await page.waitForSelector(`[data-node-id="${nodeId}"] .xterm-screen`, { timeout: 15_000 })
        await expect.poll(() => page.evaluate((id) => window.__cateE2E!.terminalPtyId(id), nodeId), { timeout: 15_000 }).not.toBeNull()
      },
    )
    const browserMs = await elapsed(
      () => page.evaluate(() => window.__cateE2E!.createBrowser('data:text/html,<title>Creation benchmark</title>', { x: 760, y: 580 }).panelId),
      async (panelId) => {
        await expect.poll(() => page.evaluate((id) => window.__cateE2E!.browserWebContentsId(id), panelId), { timeout: 15_000 }).not.toBeNull()
      },
    )

    const results = Object.fromEntries(Object.entries({ firstEditorMs, warmEditorMs, terminalMs, browserMs })
      .map(([key, value]) => [key, Math.round(value * 10) / 10]))
    console.table(results)

    expect(firstEditorMs).toBeLessThan(15_000)
    expect(warmEditorMs).toBeLessThan(5_000)
    expect(terminalMs).toBeLessThan(15_000)
    expect(browserMs).toBeLessThan(15_000)
  } finally {
    if (app) await closeApp(app)
  }
})
