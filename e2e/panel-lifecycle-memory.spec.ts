import { expect, test } from '@playwright/test'
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { closeApp, launchApp } from './fixtures/electron-app'
import { act } from './fixtures/browser-control'

// CATE_E2E_PROFILE=1 npx playwright test e2e/panel-lifecycle-memory.spec.ts --workers=1
// Produces Chrome DevTools heap snapshots and CPU profiles for real panel churn.
for (const type of ['terminal', 'editor', 'browser'] as const) {
  test(`closing ${type} panels releases resources across repeated batches`, async () => {
    test.skip(!process.env.CATE_E2E_PROFILE, 'Opt-in allocation profiling')
    test.setTimeout(300_000)
    const { electronApp: app, mainWindow: page } = await launchApp({ env: { CATE_PERF: '0' } })
    const cdp = await page.context().newCDPSession(page)
    const measurements: Array<Record<string, number>> = []
    try {
      // Discard only the synthetic edits created in this isolated test app.
      if (type === 'editor') await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      })
      await cdp.send('HeapProfiler.enable')
      await cdp.send('Profiler.enable')
      const churn = async (count: number) => {
        for (let i = 0; i < count; i++) {
          const node = await page.evaluate(type => {
            const api = window.__cateE2E!
            const point = { x: 40, y: 40 }
            if (type === 'terminal') return api.createTerminal(point)
            if (type === 'editor') return api.createEditor(point)
            const browser = api.createBrowser('data:text/html,<title>Memory profile</title><input aria-label="Text">', point)
            return api.nodeForPanel(browser.panelId)!
          }, type)
          if (type === 'terminal') {
            await expect.poll(() => page.evaluate(id => window.__cateE2E!.terminalPtyId(id), node), { timeout: 15_000 }).not.toBeNull()
            await expect(page.locator(`[data-node-id="${node}"] .xterm-screen`)).toBeVisible()
            await page.evaluate(id => window.__cateE2E!.writeTerminal(id, "printf '%s%s\\n' profile-terminal- ready\n"), node)
            await expect.poll(() => page.evaluate(id => window.__cateE2E!.terminalText(id)?.includes('profile-terminal-ready'), node)).toBe(true)
          } else if (type === 'editor') {
            const input = page.locator(`[data-node-id="${node}"] .monaco-editor textarea`)
            await expect(input).toBeVisible()
            await input.focus()
            await page.keyboard.type('profile edit')
            await expect(page.locator(`[data-node-id="${node}"] .monaco-editor`)).toContainText('profile edit')
          } else {
            await expect.poll(() => page.evaluate(id => {
              const panel = window.__cateE2E!.nodes().find(n => n.id === id)!.panelId
              return window.__cateE2E!.browserWebContentsId(panel)
            }, node), { timeout: 15_000 }).not.toBeNull()
            const browser = await page.evaluate(id => ({
              workspaceId: window.__cateE2E!.selectedWorkspaceId(),
              panelId: window.__cateE2E!.nodes().find(n => n.id === id)!.panelId,
            }), node)
            await expect(act(page, browser, 'setValue', 'Text', { value: 'profile edit' })).resolves.toMatchObject({ ok: true })
          }
          await page.locator(`[data-node-id="${node}"]`).getByRole('button', { name: 'Close', exact: true }).first().click()
          await expect(page.locator(`[data-node-id="${node}"]`)).toHaveCount(0)
          if (type === 'terminal') await expect.poll(() => page.evaluate(id => window.__cateE2E!.terminalPtyId(id), node)).toBeNull()
        }
      }
      const snapshot = async (label: string, closed: number) => {
        await page.waitForTimeout(1500)
        await cdp.send('HeapProfiler.collectGarbage')
        const dom = await cdp.send('Memory.getDOMCounters')
        const heap = await cdp.send('Runtime.getHeapUsage')
        const resources = await app.evaluate(({ app, BrowserWindow, webContents }) => {
          const pid = BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
          const metrics = app.getAppMetrics()
          return {
            rendererMB: metrics.find(m => m.pid === pid)!.memory.workingSetSize / 1024,
            totalMB: metrics.reduce((sum, m) => sum + m.memory.workingSetSize / 1024, 0),
            webContents: webContents.getAllWebContents().length,
          }
        })
        const sample = { closed, heapMB: heap.usedSize / 1024 ** 2, nodes: dom.nodes, listeners: dom.jsEventListeners, ...resources }
        measurements.push(sample)
        console.log(`${type} profile`, JSON.stringify(sample))
        expect(resources.totalMB, 'stop if the isolated workload exhausts host RAM').toBeLessThan(1500)
        const file = test.info().outputPath(`${label}.heapsnapshot`)
        mkdirSync(path.dirname(file), { recursive: true })
        const fd = openSync(file, 'w')
        const onChunk = ({ chunk }: { chunk: string }) => { writeSync(fd, chunk) }
        cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
        try { await cdp.send('HeapProfiler.takeHeapSnapshot') }
        finally { cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk); closeSync(fd) }
      }

      await churn(5) // Load fonts, workers, addons, and lazy components first.
      await snapshot('warm', 5)
      await cdp.send('Profiler.start')
      await churn(30)
      const profile = await cdp.send('Profiler.stop')
      writeFileSync(test.info().outputPath(`${type}-churn.cpuprofile`), JSON.stringify(profile.profile))
      await snapshot('after-30', 35)
      await churn(30)
      await snapshot('after-60', 65)
      const baseline = measurements[0]
      const last = measurements.at(-1)!
      expect(last.heapMB - baseline.heapMB, 'closed panels must not remain in the JS heap').toBeLessThan(10)
      expect(last.nodes - baseline.nodes, 'closed panel DOM must be collectible').toBeLessThan(200)
      expect(last.listeners - baseline.listeners, 'closed panels must release event listeners').toBeLessThan(8)
      expect(last.webContents, 'browser guests must be destroyed on close').toBe(baseline.webContents)
    } finally {
      writeFileSync(test.info().outputPath('resources.json'), JSON.stringify(measurements, null, 2))
      await closeApp(app)
    }
  })
}
