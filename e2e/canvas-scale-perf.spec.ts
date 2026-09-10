import { expect, test } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { closeApp, launchApp } from './fixtures/electron-app'

test('large mixed canvas zoom keeps mounted panel contents visible', async () => {
  test.setTimeout(90_000)
  let app: ElectronApplication | undefined
  try {
    const launched = await launchApp({ perf: true })
    app = launched.electronApp
    const page = launched.mainWindow
    await page.waitForFunction(() => Boolean(window.__catePerf))

    await page.evaluate(() => {
      const h = window.__cateE2E!
      const terminal = h.createTerminal({ x: 40, y: 40 })
      h.moveNode(terminal, { x: 40, y: 40 })
      for (let i = 0; i < 100; i++) {
        const node = h.createEditor({ x: 800 + (i % 10) * 720, y: 40 + Math.floor(i / 10) * 540 })
        h.moveNode(node, { x: 800 + (i % 10) * 720, y: 40 + Math.floor(i / 10) * 540 })
      }
      h.setZoom(0.3)
      h.resetViewport()
    })
    await page.waitForTimeout(1_000)
    await page.waitForSelector('[data-terminal-render-box]')
    expect(await page.evaluate(() => window.__cateE2E!.nodes().length)).toBe(101)

    const result = await page.evaluate(async () => {
      const h = window.__cateE2E!
      const perf = window.__catePerf!
      const before = perf.renderCounts()
      perf.resetWindow()
      const started = performance.now()
      let hiddenPanelFrames = 0
      for (let frame = 0; frame < 120; frame++) {
        h.setZoom(0.55 + 0.25 * Math.sin(frame / 9))
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const hidden = [...document.querySelectorAll<HTMLElement>('[data-node-id] [data-panel-content]')]
          .some((element) => {
            const style = getComputedStyle(element)
            return style.display === 'none' || style.visibility === 'hidden' || style.contentVisibility === 'hidden'
          })
        if (hidden) hiddenPanelFrames++
      }
      // Include the single post-gesture visibility reconciliation in the result.
      await new Promise((resolve) => setTimeout(resolve, 160))
      const after = perf.renderCounts()
      return {
        elapsedMs: performance.now() - started,
        frames: perf.frames(),
        longTasks: perf.longTasks(),
        editorCreates: (after.editorCreate ?? 0) - (before.editorCreate ?? 0),
        mountedNodes: document.querySelectorAll('[data-node-id]').length,
        hiddenPanelFrames,
      }
    })

    console.log('large mixed canvas zoom performance', result)
    expect(result.frames.fps).toBeGreaterThan(9)
    expect(result.frames.p95Ms).toBeLessThan(200)
    expect(result.editorCreates).toBeLessThanOrEqual(25)
    expect(result.hiddenPanelFrames).toBe(0)
  } finally {
    if (app) await closeApp(app)
  }
})
