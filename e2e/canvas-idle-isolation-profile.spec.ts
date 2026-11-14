// Controlled first-pan experiment: retained/released layers crossed with
// settled/resuming browser rendering. No continuous rAF or renderer polling
// during idle. Synthetic input isolates rendering from physical input delivery.
import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { launchApp, closeApp } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForBrowserGuest, waitForPty } from './fixtures/perf-helpers'

test('isolate first-pan layer promotion from browser rendering', async () => {
  test.skip(process.env.CATE_IDLE_ISOLATION !== '1', 'Opt-in visible-window rendering experiment')
  test.setTimeout(300_000)
  const chromiumArgs = process.env.CATE_IDLE_ISOLATION_CHROMIUM_ARGS?.split(' ').filter(Boolean) ?? []
  // An explicit executable bypasses Playwright's Electron loader, which
  // overwrites enable/disable-features and disables background scheduling.
  const executablePath = process.env.CATE_E2E_EXECUTABLE ?? require('electron') as string
  const { electronApp: app, mainWindow: page } = await launchApp({ executablePath, chromiumArgs, env: { CATE_E2E_BACKGROUND_THROTTLING: '1' } })
  const rows: unknown[] = []
  const idleMs = Number(process.env.CATE_IDLE_ISOLATION_MS ?? 5000)
  let tracing = false
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(1400, 950); win.show()
    })
    await installPerfHelpers(page)
    for (let i = 0; i < 4; i++) {
      const { panelId } = await create(page, 'terminal', { x: 30 + i % 2 * 600, y: 30 + Math.floor(i / 2) * 400 })
      await waitForPty(page, panelId)
      await page.evaluate(id => window.__cateE2E!.writeTerminal(id, "printf 'idle-profile-%s abcdefghijklmnopqrstuvwxyz0123456789\\n' {1..500}\n"), panelId)
    }
    const html = `<style>body{margin:0;background:#172334;color:white}.tile{display:inline-block;width:30px;height:25px;margin:2px;border-radius:5px;background:linear-gradient(35deg,#48a,#e67);box-shadow:0 0 8px #689}</style><h1>Browser resume fixture</h1><div id="tiles"></div><script>
      const tiles=document.querySelector('#tiles');
      tiles.innerHTML='<div class="tile"></div>'.repeat(8000);
      window.workFrames=0;
      window.resumeWork=()=>{
        window.workFrames=0;
        window.layoutMs=0;
        const end=performance.now()+900;
        function frame(){
          const started=performance.now();
          window.workFrames++;
          tiles.style.width=(850+window.workFrames%8)+'px';
          tiles.style.filter='hue-rotate('+window.workFrames*7+'deg)';
          void tiles.offsetHeight;
          window.layoutMs+=performance.now()-started;
          if(performance.now()<end)requestAnimationFrame(frame);
        }
        frame();
      };
    </script>`
    const { panelId } = await create(page, 'browser', { x: 400, y: 120 }, { url: 'data:text/html,' + encodeURIComponent(html) })
    const guestId = await waitForBrowserGuest(page, panelId)
    await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('typeof window.resumeWork'), guestId)).toBe('function')
    const engine = await app.evaluate(({ app, BrowserWindow, webContents }, id) => ({
      versions: process.versions, gpu: app.getGPUFeatureStatus(),
      disabledFeatures: app.commandLine.getSwitchValue('disable-features'),
      enabledFeatures: app.commandLine.getSwitchValue('enable-features'),
      hostThrottling: BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling(),
      guestThrottling: webContents.fromId(id)!.getBackgroundThrottling(),
    }), guestId)
    expect(engine.hostThrottling).toBe(false)
    expect(engine.guestThrottling).toBe(false)
    for (const arg of chromiumArgs) {
      if (arg.startsWith('--enable-features=')) expect(engine.enabledFeatures).toBe(arg.slice('--enable-features='.length))
      if (arg.startsWith('--disable-features=')) expect(engine.disabledFeatures).toBe(arg.slice('--disable-features='.length))
    }
    console.log('IDLE_ISOLATION_ENGINE', JSON.stringify(engine))
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    const layerStyle = await page.addStyleTag({ content: '/* First-pan experiment overrides. */' })
    if (process.env.CATE_IDLE_ISOLATION_TRACE === '1') {
      await app.evaluate(({ contentTracing }) => contentTracing.startRecording({ included_categories: ['devtools.timeline', 'cc', 'gpu', 'viz', 'blink.user_timing', 'toplevel', 'skia', 'disabled-by-default-skia.gpu', 'disabled-by-default-gpu.service', 'disabled-by-default-gpu.dawn'] }))
      tracing = true
    }
    for (let repeat = 0; repeat < Number(process.env.CATE_IDLE_ISOLATION_REPEATS ?? 2); repeat++) {
      // Reverse the order on alternating repetitions to reduce warm-cache bias.
      const cases = [
        { retainLayers: false, browserWork: false, browserPaint: true }, { retainLayers: true, browserWork: false, browserPaint: true },
        { retainLayers: false, browserWork: true, browserPaint: true }, { retainLayers: true, browserWork: true, browserPaint: true },
        { retainLayers: false, browserWork: true, browserPaint: false }, { retainLayers: true, browserWork: true, browserPaint: false },
      ].filter(condition => process.env.CATE_IDLE_ISOLATION_PAINT_ONLY !== '1' || (condition.browserWork && condition.browserPaint && !condition.retainLayers))
      if (repeat % 2) cases.reverse()
      for (const condition of cases) {
        // Visibility suppresses rasterization, but preserves the same DOM,
        // script, forced layout and browser animation callbacks.
        await app.evaluate(({ webContents }, { id, paint }) => webContents.fromId(id)!.executeJavaScript(`window.workFrames=0; window.layoutMs=0; document.querySelector('#tiles').style.visibility = ${JSON.stringify(paint ? 'visible' : 'hidden')}`), { id: guestId, paint: condition.browserPaint })
        await layerStyle.evaluate((style, retain) => {
          style.textContent = retain ? '[data-canvas-world],[data-canvas-top-overlay-world],[data-canvas-relation-overlay-world],[data-node-id]{will-change:transform!important}' : ''
        }, condition.retainLayers)
        await page.evaluate(() => { window.__cateE2E!.setZoom(.65); window.__cateE2E!.resetViewport() })
        await page.waitForTimeout(1200)
        const before = await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>('[data-canvas-container]')!
          const world = document.querySelector<HTMLElement>('[data-canvas-world]')!
          const initial = world.style.transform
          const result = { inputWall: 0, handlerMs: 0, firstFrameMs: null as number | null, firstMovingFrameMs: null as number | null, transformMs: null as number | null, gaps: [] as { atMs: number; ms: number }[], longTasks: [] as { at: number; duration: number }[] }
          const tasks = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) if (result.inputWall) result.longTasks.push({ at: entry.startTime, duration: entry.duration })
          })
          tasks.observe({ entryTypes: ['longtask'] })
          const observer = new MutationObserver(() => {
            if (result.inputWall && result.transformMs === null && world.style.transform !== initial) result.transformMs = performance.now() - inputAt
          })
          observer.observe(world, { attributes: true, attributeFilter: ['style'] })
          let inputAt = 0, raf = 0, lastFrame: number | null = null, timer: ReturnType<typeof setInterval>
          const frame = () => {
            const now = performance.now()
            result.firstFrameMs ??= now - inputAt
            if (world.style.transform !== initial) result.firstMovingFrameMs ??= now - inputAt
            if (lastFrame !== null) result.gaps.push({ atMs: now - inputAt, ms: now - lastFrame })
            lastFrame = now
            raf = requestAnimationFrame(frame)
          }
          // Install now, execute only after the main-process idle wait.
          ;(window as any).__startIdleIsolation = async () => {
            result.inputWall = Date.now(); inputAt = performance.now()
            performance.mark('idle-isolation-first-pan')
            const send = () => root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 4.1, deltaY: .1 }))
            raf = requestAnimationFrame(frame)
            send(); result.handlerMs = performance.now() - inputAt
            timer = setInterval(send, 16)
            await new Promise(resolve => setTimeout(resolve, 700))
            clearInterval(timer)
            performance.mark('idle-isolation-pan-ended')
            await new Promise(resolve => setTimeout(resolve, 300))
            cancelAnimationFrame(raf); observer.disconnect(); tasks.disconnect()
            return result
          }
          return { willChange: getComputedStyle(world).willChange, movingClass: world.classList.contains('canvas-world-moving'), nodes: document.querySelectorAll('[data-node-id]').length }
        })
        // No page.evaluate, animation loop or profiling HUD runs while idle.
        const native = await app.evaluate(({ BrowserWindow, webContents }, { idleMs, guestId, browserWork }) => new Promise<{ sentWall: number; result: any }>((resolve, reject) => {
          setTimeout(() => {
            const host = BrowserWindow.getAllWindows()[0].webContents
            if (browserWork) void webContents.fromId(guestId)!.executeJavaScript('window.resumeWork()').catch(reject)
            const sentWall = Date.now()
            host.executeJavaScript('window.__startIdleIsolation()').then(result => resolve({ sentWall, result }), reject)
          }, idleMs)
        }), { idleMs, guestId, browserWork: condition.browserWork })
        const guest = await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('({ frames: window.workFrames, layoutMs: window.layoutMs ?? 0 })'), guestId)
        const frames = native.result.gaps as { atMs: number; ms: number }[]
        const gaps = frames.map(frame => frame.ms)
        const activeGaps = frames.filter(frame => frame.atMs <= 700).map(frame => frame.ms)
        const row = { repeat, ...condition, idleMs, before, guest,
          deliveryMs: native.result.inputWall - native.sentWall, ...native.result,
          maxFrameMs: Math.max(...gaps), p95FrameMs: [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length * .95)],
          maxActiveFrameMs: Math.max(...activeGaps),
        }
        rows.push(row)
        writeFileSync(process.env.CATE_IDLE_ISOLATION_OUTPUT ?? test.info().outputPath('idle-isolation.json'), JSON.stringify({ engine, rows }, null, 2))
        console.log('IDLE_ISOLATION', JSON.stringify({ ...row, gaps: undefined, longTasks: row.longTasks.length }))
        expect(row.transformMs).not.toBeNull()
        expect(row.firstMovingFrameMs).not.toBeNull()
        expect(before.willChange).toBe(condition.retainLayers ? 'transform' : 'auto')
        if (condition.browserWork) {
          expect(guest.frames).toBeGreaterThan(0)
          expect(guest.layoutMs).toBeGreaterThan(0)
        }
      }
    }
  } finally {
    if (tracing) await app.evaluate(({ contentTracing }, path) => contentTracing.stopRecording(path), process.env.CATE_IDLE_ISOLATION_TRACE_OUTPUT ?? test.info().outputPath('idle-isolation-trace.json'))
    await closeApp(app)
  }
})
