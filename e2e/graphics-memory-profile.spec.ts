// Opt-in, isolated graphics lifecycle profile. No production behavior changes.
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { launchApp, closeApp, makeHome, makeProject, openWorkspace, expectTerminalText } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForPty, waitForBrowserGuest } from './fixtures/perf-helpers'

for (const mode of ['default', 'webgl2-disabled', 'territory-cpu']) {
  const domTerminals = mode === 'webgl2-disabled'
  test(`graphics memory lifecycle ${mode}`, async () => {
    test.skip(process.env.CATE_GRAPHICS_PROFILE !== '1' || process.platform !== 'darwin', 'Opt-in macOS memory profile')
    test.setTimeout(300_000)
    const home = makeHome()
    const { electronApp: app, mainWindow: page } = await launchApp({ home, domTerminals, perf: true, onWindow: async page => {
      if (mode === 'territory-cpu') {
        await page.waitForLoadState('domcontentloaded')
        await page.evaluate(() => localStorage.setItem('cate.territory.backend', 'cpu'))
      }
    } })
    const rows: unknown[] = []
    try {
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 950); w.show() })
      await installPerfHelpers(page)
      const sample = async (scenario: string) => {
        await page.waitForTimeout(3000)
        const electron = await app.evaluate(({ app, webContents }) => ({
          metrics: app.getAppMetrics(), contents: webContents.getAllWebContents().map(w => ({ pid: w.getOSProcessId(), type: w.getType() })),
        }))
        const maps = electron.metrics.map(p => {
          try {
            const raw = execFileSync('vmmap', ['-summary', String(p.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
            return { pid: p.pid, type: p.type, footprint: raw.match(/^Physical footprint:\s+(.+)$/m)?.[1], regions: raw.split('\n').filter(l => /^(IOSurface|IOAccelerator|Memory Tag|TOTAL\s)/.test(l)) }
          } catch (e) { return { pid: p.pid, type: p.type, error: String(e) } }
        })
        const dom = await page.evaluate(() => ({ dpr: devicePixelRatio, terminals: document.querySelectorAll('.xterm').length, terminalCanvases: document.querySelectorAll('.xterm canvas').length, canvases: [...document.querySelectorAll('canvas')].map(c => ({ width: c.width, height: c.height })), guests: document.querySelectorAll('webview').length }))
        rows.push({ scenario, at: new Date().toISOString(), electron, maps, dom })
        writeFileSync(test.info().outputPath('graphics-memory.json'), JSON.stringify({ mode, domTerminals, rows }, null, 2))
        console.log('GRAPHICS', scenario, JSON.stringify({ maps, dom }))
      }
      const close = async (ids: string[]) => {
        expect(await page.evaluate(ids => window.__cateE2E!.propose({ kind: 'removePanels', ids, discard: ids }), ids)).toEqual({ ok: true })
        await page.waitForFunction(ids => ids.every(id => !window.__cateE2E!.panels().some(p => p.id === id)), ids)
      }
      await sample('empty-canvas')
      const terminals: string[] = []
      for (let i = 0; i < 5; i++) {
        const { panelId } = await create(page, 'terminal', { x: 20 + i * 60, y: 20 + i * 50 })
        terminals.push(panelId)
        await waitForPty(page, panelId)
        await page.evaluate(id => window.__cateE2E!.writeTerminal(id, "printf 'GRAPHICS-%s abcdefghijklmnopqrstuvwxyz0123456789\\n' {1..3000}; echo GRAPHICS-'DONE'\n"), panelId)
        await expectTerminalText(page, panelId, 'GRAPHICS-DONE')
      }
      await sample('five-terminals-visible')
      const interactions = await page.evaluate(async () => {
        const gaps: number[] = []
        let last = performance.now()
        for (let i = 0; i < 180; i++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
          const now = performance.now()
          gaps.push(now - last)
          last = now
          if (i < 60) window.__cateE2E!.setViewport({ x: 60 * Math.sin(i / 8), y: 30 * Math.cos(i / 8) })
          else if (i < 120) (window.__cateE2E!.setZoom as (zoom: number) => void)(1 + 0.15 * Math.sin(i / 8))
          else for (const viewport of document.querySelectorAll<HTMLElement>('.xterm-viewport')) viewport.scrollTop = i % 2 ? 0 : viewport.scrollHeight
        }
        window.__cateE2E!.setViewport({ x: 0, y: 0 })
        ;(window.__cateE2E!.setZoom as (zoom: number) => void)(1)
        gaps.sort((a, b) => a - b)
        return { frames: gaps.length, p95Ms: gaps[Math.floor(gaps.length * 0.95)], maxMs: gaps.at(-1), meanMs: gaps.reduce((a, b) => a + b) / gaps.length }
      })
      console.log('GRAPHICS_INTERACTION', JSON.stringify(interactions))
      expect(interactions.p95Ms).toBeLessThan(50)
      expect(interactions.maxMs).toBeLessThan(500)
      await page.evaluate(() => window.__cateE2E!.setViewport({ x: -20000, y: -20000 }))
      await sample('terminals-offscreen')
      await page.evaluate(() => window.__cateE2E!.setViewport({ x: 0, y: 0 }))
      await close(terminals)
      await sample('terminals-closed')
      const browsers: string[] = []
      for (let i = 0; i < 3; i++) {
        const { panelId } = await create(page, 'browser', { x: 20 + i * 80, y: 20 + i * 60 }, { url: `data:text/html,<title>Graphics ${i}</title><p>Tiny local page</p>` })
        browsers.push(panelId)
        await waitForBrowserGuest(page, panelId)
      }
      await sample('three-browsers-visible')
      await page.evaluate(() => window.__cateE2E!.setViewport({ x: -20000, y: -20000 }))
      await sample('browsers-offscreen')
      const original = await page.evaluate(() => window.__cateE2E!.workspaceIds()[0])
      await openWorkspace(page, makeProject(home, { name: 'other' }))
      await sample('browsers-background-workspace')
      await page.evaluate(id => window.__cateE2E!.selectWorkspace(id), original)
      await close(browsers)
      await sample('browsers-closed')
      await page.waitForTimeout(15000)
      await sample('after-close-idle')
    } finally { await closeApp(app, { home }) }
  })
}
