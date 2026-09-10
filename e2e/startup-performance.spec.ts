import { performance } from 'node:perf_hooks'
import { test, expect } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { closeApp, launchApp } from './fixtures/electron-app'

test('isolated-user-data startup reaches an interactive shell', async () => {
  let app: ElectronApplication | undefined
  const started = performance.now()
  try {
    const launched = await launchApp({ empty: true, perf: true })
    app = launched.electronApp
    const readyMs = performance.now() - started
    const processes = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((process) => ({
      type: process.type,
      cpu: process.cpu.percentCPUUsage,
      memMB: Math.round(process.memory.workingSetSize / 1024),
    })))

    console.log('startup performance', {
      readyMs: Math.round(readyMs * 10) / 10,
      processes,
    })

    // Keep this as a regression tripwire, not a hardware-specific target.
    expect(readyMs).toBeLessThan(15_000)
  } finally {
    if (app) await closeApp(app)
  }
})
