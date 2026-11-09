// Opt-in measurement, not a machine-dependent CI timing gate.
import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { closeApp, launchApp, makeHome, makeProject, expectTerminalText } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForPty, waitForBrowserGuest } from './fixtures/perf-helpers'

test('canvas gesture resource profile', async () => {
  test.skip(process.env.CATE_GESTURE_PROFILE !== '1', 'Opt-in visible-window benchmark')
  test.setTimeout(600_000)
  const home = makeHome()
  const project = makeProject(home, { git: true, files: { 'sample.ts': Array.from({ length: 2500 }, (_, i) => `export const value${i} = { name: 'line ${i}', enabled: true }`).join('\n') } })
  execFileSync('git', ['add', '.'], { cwd: project })
  execFileSync('git', ['-c', 'user.name=Profile', '-c', 'user.email=profile@example.test', 'commit', '-qm', 'fixture'], { cwd: project })
  writeFileSync(path.join(project, 'sample.ts'), Array.from({ length: 2500 }, (_, i) => `export const value${i} = { name: 'modified ${i}', enabled: false }`).join('\n'))
  const { electronApp: app, mainWindow: page } = await launchApp({ home, workspace: project, perf: true, domTerminals: process.env.CATE_GESTURE_DOM_TERMINALS === '1' })
  const windowId = await (await app.browserWindow(page)).evaluate(w => w.id as number)
  const rows: unknown[] = []
  const budgetFailures: string[] = []
  const output = process.env.CATE_GESTURE_OUTPUT ?? test.info().outputPath('canvas-gestures.json')
  try {
    await app.evaluate(async ({ app, BrowserWindow }) => { if (process.platform === 'darwin') app.setActivationPolicy('regular'); await app.dock?.show(); app.show(); const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 950); w.show(); app.focus({ steal: true }); w.focus() })
    console.log('NATIVE_STARTUP', await app.evaluate(({ app, BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ id:w.id, title:w.getTitle(), appHidden:app.isHidden(), visible:w.isVisible(), focused:w.isFocused(), focusable:w.isFocusable(), minimized:w.isMinimized(), destroyed:w.isDestroyed() }))))
    await installPerfHelpers(page)
    await expect.poll(() => app.evaluate(({ app, BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; if (!w.isFocused()) { app.show(); app.focus({ steal: true }); w.focus() }; return w.isFocused() })).toBe(true)
    page.on('console', msg => { if (/webglcontextlost|webglcontextrestored|context not restored/i.test(msg.text())) console.log('TERMINAL_GPU', msg.text()) })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const hardware = { platform: process.platform, release: os.release(), cpu: os.cpus()[0].model, cores: os.cpus().length, ramGiB: os.totalmem() / 2 ** 30 }
    const gpu = await app.evaluate(async ({ app }) => app.getGPUInfo('complete'))
    const layoutColumns = Number(process.env.CATE_GESTURE_COLUMNS ?? 3)
    const initialZoom = process.env.CATE_GESTURE_INITIAL_ZOOM === undefined ? null : Number(process.env.CATE_GESTURE_INITIAL_ZOOM)
    const completions: unknown[] = []
    const sample = () => app.evaluate(({ app, BrowserWindow }, id) => ({ at: Date.now(), metrics: app.getAppMetrics(), focused: BrowserWindow.fromId(id)?.isFocused() ?? false }), windowId)
    const ids: string[] = []
    const clear = async () => {
      await page.waitForFunction(() => !document.body.classList.contains('canvas-zooming') && !document.body.classList.contains('canvas-interacting'))
      if (ids.length) expect(await page.evaluate(ids => window.__cateE2E!.propose({ kind: 'removePanels', ids, discard: ids }), ids.splice(0))).toEqual({ ok: true })
      await page.evaluate(() => { window.__cateE2E!.setZoom(0.8); window.__cateE2E!.resetViewport() })
    }
    for (const scenario of (process.env.CATE_GESTURE_SCENARIOS ?? 'empty,terminals,editors,browsers,browsers-heavy,mixed,mixed-24,reviews,terminals-active').split(',')) {
      await clear()
      if (initialZoom !== null) await page.evaluate(zoom => window.__cateE2E!.setZoom(zoom), initialZoom)
      let focusedNodeId: string | null = null
      const count = scenario === 'empty' ? 0 : Number(process.env.CATE_GESTURE_COUNT ?? (scenario === 'mixed-24' ? 24 : 6))
      for (let i = 0; i < count; i++) {
        const type = scenario.startsWith('mixed') ? ['terminal', 'editor', 'browser'][i % 3] : scenario === 'terminals-active' ? 'terminal' : scenario === 'browsers-heavy' ? 'browser' : scenario.slice(0, -1)
        let html = `<html><style>body{background:#182331;color:white}.box{display:inline-block;width:80px;height:60px;margin:4px;background:linear-gradient(45deg,#a45,#47a);animation:spin 2s infinite alternate}@keyframes spin{to{transform:rotate(15deg)}}</style><h1>Local animated page</h1>${'<div class=box></div>'.repeat(60)}</html>`
        if (scenario === 'browsers-heavy') html = `<html><style>body{margin:0;background:#182331;color:white}.tile{display:inline-block;width:22px;height:16px;margin:2px;background:linear-gradient(45deg,#a45,#47a)}</style><canvas width="1200" height="800" style="width:100%;height:400px"></canvas>${'<span class=tile></span>'.repeat(4000)}<script>
          const ctx=document.querySelector('canvas').getContext('2d'); window.drawnFrames=0;
          function draw(t){window.drawnFrames++;ctx.fillStyle='#182331';ctx.fillRect(0,0,1200,800);
            for(let n=0;n<600;n++){ctx.fillStyle='hsl('+((n+t/20)%360)+' 70% 55%)';ctx.fillRect((n*37+t/15)%1200,(n*53+t/30)%800,30,20)}
            requestAnimationFrame(draw)}requestAnimationFrame(draw);
        </script></html>`
        const options = type === 'review' ? { repoPath: project } : type === 'editor' ? { filePath: path.join(project, 'sample.ts') } : type === 'browser' ? { url: `data:text/html,${encodeURIComponent(html)}` } : {}
        const { panelId } = await create(page, type, { x: 30 + (i % layoutColumns) * 480, y: 30 + Math.floor(i / layoutColumns) * 360 }, options)
        ids.push(panelId)
        if (type === 'terminal') {
          await waitForPty(page, panelId)
          await page.evaluate(id => window.__cateE2E!.writeTerminal(id, "printf 'PROFILE-%s abcdefghijklmnopqrstuvwxyz0123456789\\n' {1..3000}; echo PROFILE-'DONE'\n"), panelId)
          await expectTerminalText(page, panelId, 'PROFILE-DONE')
        }
        if (type === 'browser') await waitForBrowserGuest(page, panelId)
      }
      if (process.env.CATE_GESTURE_FOCUS_TERMINAL === '1') {
        const terminal = await page.evaluate(() => window.__cateE2E!.panels().find(p => p.type === 'terminal'))
        if (!terminal) throw new Error('focused-terminal profile needs a terminal')
        focusedNodeId = await page.evaluate(id => window.__cateE2E!.nodeForPanel(id), terminal.id)
        await page.locator(`[data-node-id="${focusedNodeId}"]`).click({ position: { x: 50, y: 50 } })
        if (process.env.CATE_GESTURE_DOM_TERMINALS !== '1') await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLCanvasElement>('.xterm canvas')].filter(c => c.getContext('webgl2')?.isContextLost() === false).length)).toBeGreaterThan(0)
      }
      if (scenario === 'reviews') await expect(page.locator('[data-review-file]')).toHaveCount(count, { timeout: 30000 })
      if (scenario === 'terminals-active') {
        const bytes = Number(process.env.CATE_GESTURE_ACTIVE_BYTES ?? 26)
        const iterations = Number(process.env.CATE_GESTURE_ACTIVE_ITERATIONS ?? 1200)
        const delay = Number(process.env.CATE_GESTURE_ACTIVE_DELAY ?? .05)
        expect(Number.isInteger(bytes) && bytes >= 1 && bytes <= 8192).toBe(true)
        expect(Number.isInteger(iterations) && iterations > 0 && iterations <= 20000).toBe(true)
        expect(Number.isFinite(delay) && delay >= .001 && delay <= 1).toBe(true)
        const command = `for i in {1..${iterations}}; do printf 'active output %s ${'x'.repeat(bytes)}\\n' $i; sleep ${delay}; done; echo ARCH-STREAM-DONE\n`
        for (const id of ids) await page.evaluate(({ id, command }) => window.__cateE2E!.writeTerminal(id, command), { id, command })
      }
      if (initialZoom !== null) await page.evaluate(zoom => { window.__cateE2E!.setZoom(zoom); window.__cateE2E!.resetViewport() }, initialZoom)
      await page.waitForTimeout(2500)
      for (const action of (process.env.CATE_GESTURE_ACTIONS ?? 'idle,pan,zoom-out,zoom-in').split(',')) {
        for (let repeat = 0; repeat < Number(process.env.CATE_GESTURE_REPEATS ?? 2); repeat++) {
          await page.waitForFunction(() => !document.body.classList.contains('canvas-zooming'))
          await page.evaluate(({ action, initialZoom }) => { window.__cateE2E!.resetViewport(); window.__cateE2E!.setZoom(initialZoom ?? (action === 'zoom-in' ? 0.35 : 0.8)) }, { action, initialZoom })
          await page.waitForTimeout(400)
          if (focusedNodeId) {
            await page.locator(`[data-node-id="${focusedNodeId}"]`).click({ position: { x: 50, y: 50 } })
            if (process.env.CATE_GESTURE_DOM_TERMINALS !== '1') await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLCanvasElement>('.xterm canvas')].filter(c => c.getContext('webgl2')?.isContextLost() === false).length)).toBeGreaterThan(0)
          }
          // Restore the actual host after panel setup; never refocus during measurement.
          await app.evaluate(({ app, BrowserWindow }, id) => { const w = BrowserWindow.fromId(id)!; app.show(); w.show(); app.focus({ steal: true }); w.focus(); w.webContents.focus() }, windowId)
          await expect.poll(() => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isFocused() ?? false, windowId)).toBe(true)
          await page.waitForTimeout(200)
          const trace = process.env.CATE_GESTURE_TRACE && scenario === (process.env.CATE_GESTURE_TRACE_SCENARIO ?? 'mixed-24') && action === (process.env.CATE_GESTURE_TRACE_ACTION ?? 'pan') && repeat === 0
          if (trace) await app.evaluate(async ({ contentTracing }) => contentTracing.startRecording({ included_categories: ['devtools.timeline', 'cc', 'gpu', 'viz', 'blink.user_timing', 'v8', 'disabled-by-default-v8.gc'] }))
          const guestFrames = () => app.evaluate(async ({ webContents }) => Promise.all(webContents.getAllWebContents().filter(w => w.getType() === 'webview').map(async w => ({ id: w.id, frames: await w.executeJavaScript('window.drawnFrames ?? null') }))))
          const guestFramesBefore = scenario === 'browsers-heavy' ? await guestFrames() : undefined
          const before = await cdp.send('Performance.getMetrics')
          await sample() // prime interval CPU measurement
          const resources: unknown[] = []
          const gpuSamples: unknown[] = []
          const timer = setInterval(() => { void sample().then(s => resources.push(s)); if (process.platform === 'darwin') { const raw = execFileSync('ioreg', ['-r', '-c', 'AGXAccelerator', '-l'], { encoding: 'utf8' }); gpuSamples.push(raw.split('\n').find(l => l.includes('"PerformanceStatistics"')) ?? null) } }, 1000)
          let gesture
          try {
            gesture = await page.evaluate(async action => {
              const root = document.querySelector<HTMLElement>('[data-canvas-container]')!
              const rect = root.getBoundingClientRect()
              const gaps: number[] = []
              const slowFrames: Array<{ at: number; gapMs: number }> = []
              const start = performance.now()
              const wallStart = Date.now()
              let last = start
              window.__catePerf!.resetWindow()
              const counters = window.__catePerf!.renderCounts()
              const domElements = document.querySelectorAll('*').length
              const schedulerStatsBefore = (window as any).__cateSchedulerStats?.()
              const startTransform = document.querySelector<HTMLElement>('[data-canvas-world]')!.style.transform
              let inputs = 0
              // Keep producing input when presentation stalls; do not reduce
              // the workload by dispatching only once per successful frame.
              const inputTimer = action === 'idle' ? null : setInterval(() => {
                const elapsed = performance.now() - start
                const zoom = action.startsWith('zoom')
                inputs++
                root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, ctrlKey: zoom,
                  deltaX: zoom ? 0 : Math.cos(elapsed / 500) * 8.1,
                  deltaY: zoom ? (action === 'zoom-in' ? -0.2 : 0.2) : Math.sin(elapsed / 500) * 6.1, deltaMode: 0 }))
              }, 16)
              while (performance.now() - start < 4000) {
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
                const now = performance.now()
                if (now - last > 25) { slowFrames.push({ at: now, gapMs: now - last }); performance.mark('gesture-slow-frame') }
                gaps.push(now - last); last = now
              }
              if (inputTimer !== null) clearInterval(inputTimer)
              gaps.sort((a, b) => a - b)
              const mountedAtGestureEnd = { nodes: document.querySelectorAll('[data-node-id]').length, editors: document.querySelectorAll('.monaco-editor').length, terminals: document.querySelectorAll('.xterm').length, terminalCanvases: document.querySelectorAll('.xterm canvas').length, terminalWebglCanvases: [...document.querySelectorAll<HTMLCanvasElement>('.xterm canvas')].filter(c => c.getContext('webgl2')?.isContextLost() === false).length, browsers: document.querySelectorAll('webview').length }
              const activeElapsedMs = performance.now() - start
              const after = window.__catePerf!.renderCounts()
              const activeLongTasks = window.__catePerf!.longTasks()
              const schedulerStatsAtGestureEnd = (window as any).__cateSchedulerStats?.()
              const recoveryGaps: number[] = []
              const recoveryStart = performance.now()
              let recoveryPrevious = recoveryStart
              while (performance.now() - recoveryStart < 1000) {
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
                const now = performance.now()
                recoveryGaps.push(now - recoveryPrevious); recoveryPrevious = now
              }
              recoveryGaps.sort((a, b) => a - b)
              const recovery = {
                elapsedMs: performance.now() - recoveryStart,
                p95Ms: recoveryGaps[Math.floor(recoveryGaps.length * .95)],
                maxMs: recoveryGaps.at(-1), over25ms: recoveryGaps.filter(x => x > 25).length,
                domElements: document.querySelectorAll('*').length,
                details: document.querySelectorAll('[data-node-detail-level="detail"]').length,
                previews: document.querySelectorAll('[data-node-detail-level="preview"]').length,
                editors: document.querySelectorAll('.monaco-editor').length,
                terminals: document.querySelectorAll('.xterm').length,
                schedulerStats: (window as any).__cateSchedulerStats?.(),
              }
              return { wallStart, inputs, inputCadenceMs: 16, bodyClasses: document.body.className, focusedPanels: [...document.querySelectorAll('[data-node-active="true"]')].map(el => el.getAttribute('data-active-panel-id')), slowFrames, domElements, startTransform, endTransform: document.querySelector<HTMLElement>('[data-canvas-world]')!.style.transform, elapsedMs: activeElapsedMs, recovery, frames: gaps.length, fps: gaps.length * 1000 / activeElapsedMs, p50Ms: gaps[Math.floor(gaps.length * .5)], p95Ms: gaps[Math.floor(gaps.length * .95)], p99Ms: gaps[Math.floor(gaps.length * .99)], maxMs: gaps.at(-1), over25ms: gaps.filter(x => x > 25).length, over50ms: gaps.filter(x => x > 50).length, longTasks: activeLongTasks, counters: Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v - (counters[k] ?? 0)])), mounted: mountedAtGestureEnd, schedulerStatsBefore, schedulerStatsAfter: schedulerStatsAtGestureEnd, dpr: devicePixelRatio }
            }, action)
          } finally { clearInterval(timer) }
          if (action !== 'idle') expect(gesture.endTransform).not.toBe(gesture.startTransform)

          if (trace) await app.evaluate(async ({ contentTracing }, destination) => contentTracing.stopRecording(destination), process.env.CATE_GESTURE_TRACE!)
          resources.push(await sample())
          const foregroundValid = resources.every((value: any) => value.focused === true)
          const after = await cdp.send('Performance.getMetrics')
          rows.push({ scenario, count, action, repeat, foregroundValid, gesture, resources, gpuSamples, guestFramesBefore, guestFramesAfter: scenario === 'browsers-heavy' ? await guestFrames() : undefined, rendererMetricsBefore: before.metrics, rendererMetricsAfter: after.metrics })
          writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), domTerminals: process.env.CATE_GESTURE_DOM_TERMINALS === '1', focusedTerminal: process.env.CATE_GESTURE_FOCUS_TERMINAL === '1', variant: process.env.CATE_ARCH_VARIANT ?? null, layoutColumns, initialZoom, hardware, gpu, rows, completions }, null, 2))
          console.log('GESTURE', scenario, action, repeat, JSON.stringify(gesture))
          expect(foregroundValid, 'foreground performance trial lost native window focus').toBe(true)
          if (process.env.CATE_GESTURE_ASSERT_SMOOTH === '1' && (gesture.p95Ms >= 16.7 || gesture.p99Ms >= 25 || gesture.maxMs! >= 25 || gesture.recovery.maxMs! >= 25)) {
            budgetFailures.push(`${scenario}/${action}/${repeat}: p95=${gesture.p95Ms.toFixed(1)} p99=${gesture.p99Ms.toFixed(1)} max=${gesture.maxMs!.toFixed(1)} ms`)
          }
        }
      }
      if (scenario === 'terminals-active' && process.env.CATE_ARCH_COMPLETION === '1') {
        const drainStarted = Date.now()
        for (const id of ids) await expectTerminalText(page, id, 'ARCH-STREAM-DONE', { timeout: 120_000 })
        await page.waitForFunction(() => {
          const stats = (window as any).__cateSchedulerStats?.()
          return !stats || (stats.pendingTerminalBytes === 0 && stats.queuedJobs === 0 && !stats.inFlight)
        }, undefined, { timeout: 60_000 })
        completions.push({ scenario, panelCount: ids.length, drainedAfterGesturesMs: Date.now() - drainStarted, scheduler: await page.evaluate(() => (window as any).__cateSchedulerStats?.() ?? null) })
        writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), variant: process.env.CATE_ARCH_VARIANT ?? null, layoutColumns, initialZoom, hardware, gpu, rows, completions }, null, 2))
      }
    }
    expect(budgetFailures, 'Gesture frame budget failures').toEqual([])
  } finally { await closeApp(app, { home }) }
})
