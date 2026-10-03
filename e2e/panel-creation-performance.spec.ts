import { performance } from 'node:perf_hooks'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForBrowserGuest, waitForPty } from './fixtures/perf-helpers'

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
    await installPerfHelpers(page)

    const editorReady = ({ nodeId }: { nodeId: string }) => page.waitForSelector(`[data-node-id="${nodeId}"] .monaco-editor textarea`, { timeout: 15_000 }).then(() => {})
    const firstEditorMs = await elapsed(() => create(page, 'editor', { x: 40, y: 40 }), editorReady)
    const warmEditorMs = await elapsed(() => create(page, 'editor', { x: 760, y: 40 }), editorReady)
    const terminalMs = await elapsed(
      () => create(page, 'terminal', { x: 40, y: 580 }),
      async ({ nodeId, panelId }) => {
        await page.waitForSelector(`[data-node-id="${nodeId}"] .xterm-screen`, { timeout: 15_000 })
        await waitForPty(page, panelId)
      },
    )
    const browserMs = await elapsed(
      () => create(page, 'browser', { x: 760, y: 580 }, { url: 'data:text/html,<title>Creation benchmark</title>' }),
      async ({ panelId }) => { await waitForBrowserGuest(page, panelId) },
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

// Browser panels created back to back (no pause) all get a session snapshot:
// the runtime starts each request in arrival order, so a session subscribe
// sent right after the op that adds the panel finds its session.
test('browser panels created back to back all publish a session snapshot', async () => {
  let app: ElectronApplication | undefined
  try {
    const launched = await launchApp({ perf: true })
    app = launched.electronApp
    const page = launched.mainWindow
    await installPerfHelpers(page)
    const ids: string[] = []
    for (let i = 0; i < 10; i++) ids.push((await create(page, 'browser', { x: 20 + (i % 5) * 60, y: 20 + Math.floor(i / 5) * 50 }, { url: 'about:blank' })).panelId)
    for (const id of ids) await waitForBrowserGuest(page, id)
  } finally {
    if (app) await closeApp(app)
  }
})
