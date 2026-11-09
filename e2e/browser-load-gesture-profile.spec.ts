// Opt-in page-load/gesture overlap, with local fixtures and optional real GitHub pages.
import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { rmSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { launchApp, closeApp } from './fixtures/electron-app'
import { copyElectronForColdGpuCache } from './fixtures/cold-electron'
import { create, installPerfHelpers, waitForBrowserGuest } from './fixtures/perf-helpers'
import type { Page } from 'playwright'

export async function measureBrowserGesture(page: Page, action: string, durationMs = 5000) {
  return page.evaluate(async ({ action, durationMs }) => {
    const w = window as unknown as { __loadGestureRunning: boolean }
    const root = document.querySelector<HTMLElement>('[data-canvas-container]')!
    const world = document.querySelector<HTMLElement>('[data-canvas-world]')!
    const rect = root.getBoundingClientRect()
    const initial = world.style.transform
    const gaps: number[] = [], slowFrames: Array<{ at: number; ms: number }> = []
    let firstInputAt: number | null = null, firstMoveAt: number | null = null
    const observer = new MutationObserver(() => { if (firstInputAt !== null && firstMoveAt === null && world.style.transform !== initial) firstMoveAt = performance.now() })
    observer.observe(world, { attributes: true, attributeFilter: ['style'] })
    window.__catePerf!.resetWindow()
    const counts = window.__catePerf!.renderCounts()
    const started = performance.now()
    let last = started, raf = 0
    const frame = (now: number) => {
      const ms = now - last
      gaps.push(ms)
      if (ms > 25) { slowFrames.push({ at: now, ms }); performance.mark('browser-load-slow-frame') }
      last = now
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    const input = setInterval(() => {
      if (action === 'idle') return
      firstInputAt ??= performance.now()
      const t = performance.now() - started
      root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + 80, ctrlKey: action === 'zoom', deltaMode: 0,
        deltaX: action === 'pan' ? 3.1 * Math.cos(t / 700) : 0,
        deltaY: action === 'pan' ? 2.1 * Math.sin(t / 700) : 0.3 * Math.cos(t / 700) }))
    }, 16)
    w.__loadGestureRunning = true
    await new Promise(resolve => setTimeout(resolve, durationMs))
    clearInterval(input); cancelAnimationFrame(raf); observer.disconnect(); w.__loadGestureRunning = false
    const elapsedMs = performance.now() - started
    const after = window.__catePerf!.renderCounts()
    gaps.sort((a, b) => a - b)
    return { elapsedMs, fps: gaps.length * 1000 / elapsedMs, frames: gaps.length, p50Ms: gaps[Math.floor(gaps.length * .5)], p95Ms: gaps[Math.floor(gaps.length * .95)], p99Ms: gaps[Math.floor(gaps.length * .99)], maxMs: gaps.at(-1), slowFrames, firstInputDelayMs: firstInputAt === null || firstMoveAt === null ? null : firstMoveAt - firstInputAt,
      longTasks: window.__catePerf!.longTasks(), counters: Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v - (counts[k] ?? 0)])), transformChanged: world.style.transform !== initial, dpr: devicePixelRatio }
  }, { action, durationMs })
}

test('browser navigation and loading overlap canvas gestures', async () => {
  test.skip(process.env.CATE_BROWSER_LOAD_PROFILE !== '1', 'Opt-in visible-window load profile')
  test.setTimeout(360_000)
  const pixels = Buffer.alloc(1600 * 1000 * 3)
  let seed = 12345
  for (let i = 0; i < pixels.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[i] = seed >>> 24 }
  const image = await sharp(pixels, { raw: { width: 1600, height: 1000, channels: 3 } }).jpeg({ quality: 85 }).toBuffer()
  const requests: Array<{ at: number; url: string }> = []
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture')
    requests.push({ at: Date.now(), url: req.url! })
    res.setHeader('Cache-Control', 'no-store')
    if (url.pathname === '/slow.svg') {
      res.setHeader('Content-Type', 'image/svg+xml')
      setTimeout(() => { if (!res.destroyed) res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>') }, 4500)
      return
    }
    if (url.pathname === '/photo.jpg') { res.setHeader('Content-Type', 'image/jpeg'); res.end(image); return }
    const kind = url.pathname.slice(1)
    res.setHeader('Content-Type', 'text/html')
    const heavy = kind === 'script' || kind === 'combined'
    const images = kind === 'images' || kind === 'combined'
    res.end(`<html><title>${kind}</title><style>body{margin:0;background:#172334;color:white}.row{display:inline-block;width:80px;padding:3px;border:1px solid #456}img.photo{width:24%;height:160px;object-fit:cover}</style><h1>${kind}</h1>
      <script>window.__loadProfile={started:performance.now(),frames:0,longTasks:0,done:false};new PerformanceObserver(l=>window.__loadProfile.longTasks+=l.getEntries().length).observe({entryTypes:['longtask']});</script>
      ${kind === 'settled' ? '' : `<img src="/slow.svg?${url.searchParams.get('run')}">`}
      ${images ? Array.from({ length: 16 }, (_, i) => `<img class="photo" src="/photo.jpg?run=${url.searchParams.get('run')}&i=${i}">`).join('') : ''}
      ${heavy ? `<div id="rows"></div><script>
        const parent=document.querySelector('#rows');parent.innerHTML=Array.from({length:16000},(_,i)=>'<div class="row"><button>Row '+i+'</button><span>Load fixture</span></div>').join('');
        const end=performance.now()+3500;function work(){window.__loadProfile.frames++;const start=performance.now();while(performance.now()-start<10){};parent.style.width=(950+window.__loadProfile.frames%8)+'px';void parent.offsetHeight;if(performance.now()<end)requestAnimationFrame(work);else window.__loadProfile.done=true}requestAnimationFrame(work);
      </script>` : '<script>window.__loadProfile.done=true</script>'}</html>`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const chromiumArgs = process.env.CATE_BROWSER_LOAD_SURFACE_DEADLINE === undefined ? [] : [`--deadline-to-synchronize-surfaces=${process.env.CATE_BROWSER_LOAD_SURFACE_DEADLINE}`]
  if (process.env.CATE_BROWSER_LOAD_CPU_RASTER === '1') chromiumArgs.push('--disable-gpu-rasterization')
  if (process.env.CATE_BROWSER_LOAD_GRAPHITE === '1') chromiumArgs.push('--enable-skia-graphite')
  if (process.env.CATE_BROWSER_LOAD_GRAPHITE === '0') chromiumArgs.push('--disable-skia-graphite')
  if (process.env.CATE_BROWSER_LOAD_PRECOMPILE === '1') chromiumArgs.push('--enable-skia-graphite-precompilation')
  if (process.env.CATE_BROWSER_LOAD_DRDC === '1') chromiumArgs.push('--enable-features=EnableDrDc')
  if (process.env.CATE_BROWSER_LOAD_DRDC === 'separate') chromiumArgs.push('--enable-features=EnableDrDc', '--disable-features=GraphiteContextIsThreadSafe')
  if (process.env.CATE_BROWSER_LOAD_ANGLE === 'gl') chromiumArgs.push('--use-angle=gl')
  let coldBundle: string | undefined
  const env: Record<string, string> = process.env.CATE_BROWSER_LOAD_DRDC === 'separate' ? { CATE_E2E_BACKGROUND_THROTTLING: '1' } : {}
  if (process.env.CATE_BROWSER_LOAD_COLD_BUNDLE === '1') {
    const source = process.env.CATE_E2E_EXECUTABLE ?? require('electron') as string
    const copy = copyElectronForColdGpuCache(source)
    coldBundle = copy.root
    env.CATE_E2E_EXECUTABLE = copy.executablePath
  }
  const { electronApp: app, mainWindow: page } = await launchApp({ perf: true, chromiumArgs, env, executablePath: env.CATE_E2E_EXECUTABLE })
  const rows: unknown[] = []
  const budgetFailures: string[] = []
  try {
    const engine = await app.evaluate(async ({ app }) => ({ versions: process.versions, surfaceDeadline: app.commandLine.getSwitchValue('deadline-to-synchronize-surfaces'), gpu: app.getGPUFeatureStatus(), gpuInfo: await app.getGPUInfo('complete') }))
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 950); w.show(); w.focus() })
    await installPerfHelpers(page)
    if (process.env.CATE_BROWSER_LOAD_NO_GRID === '1') await page.addStyleTag({ content: '[data-canvas-grid]{display:none!important}' })
    await page.waitForFunction(() => !!window.__catePerf)
    const ids: number[] = []
    for (let i = 0; i < Number(process.env.CATE_BROWSER_LOAD_COUNT ?? 1); i++) {
      const { panelId } = await create(page, 'browser', { x: 300 + i % 2 * 400, y: 60 + Math.floor(i / 2) * 340 }, { url: origin + '/settled' })
      ids.push(await waitForBrowserGuest(page, panelId))
    }
    await app.evaluate(({ webContents }, ids) => {
      for (const id of ids) {
        const guest = webContents.fromId(id)! as any
        guest.__gestureAudit = { events: [], cdp: {} }
        for (const name of ['did-start-loading', 'dom-ready', 'did-finish-load', 'did-stop-loading']) guest.on(name, () => guest.__gestureAudit.events.push({ at: Date.now(), name }))
        guest.on('did-fail-load', (_event: unknown, code: number, description: string, url: string, mainFrame: boolean) => guest.__gestureAudit.events.push({ at: Date.now(), name: 'did-fail-load', code, description, url, mainFrame }))
        guest.debugger.on('message', (_e: unknown, method: string) => { const c = guest.__gestureAudit.cdp; c[method] = (c[method] ?? 0) + 1 })
      }
    }, ids)
    const sample = () => app.evaluate(({ app, webContents, BrowserWindow }, ids) => ({ at: Date.now(), focused: BrowserWindow.getAllWindows()[0].isFocused(), metrics: app.getAppMetrics(), guests: ids.map(id => { const w = webContents.fromId(id)!; return { id, pid: w.getOSProcessId(), loading: w.isLoading(), url: w.getURL() } }) }), ids)
    for (const kind of (process.env.CATE_BROWSER_LOAD_CASES ?? 'settled,network,script,images,combined').split(',')) {
      for (const action of ['pan', 'zoom']) {
        for (let repeat = 0; repeat < Number(process.env.CATE_BROWSER_LOAD_REPEATS ?? 2); repeat++) {
          await page.waitForFunction(() => !document.body.classList.contains('canvas-zooming') && !document.body.classList.contains('canvas-interacting'))
          await app.evaluate(async ({ webContents }, { ids, origin }) => { await Promise.all(ids.map(id => webContents.fromId(id)!.loadURL(origin + '/settled'))) }, { ids, origin })
          await page.evaluate(() => { window.__cateE2E!.setZoom(.8); window.__cateE2E!.resetViewport() })
          await page.waitForTimeout(800)
          await app.evaluate(({ webContents }, ids) => { for (const id of ids) (webContents.fromId(id)! as any).__gestureAudit = { events: [], cdp: {} } }, ids)
          const remote = kind === 'github-home' || kind === 'github-repository'
          if (remote && repeat === 0) await app.evaluate(async ({ webContents }, ids) => { await Promise.all(ids.map(id => webContents.fromId(id)!.session.clearCache())) }, ids)
          if (remote && process.env.CATE_BROWSER_LOAD_SHADER_COLD === '1') await app.evaluate(async ({ webContents }, ids) => { await Promise.all(ids.map(id => webContents.fromId(id)!.session.clearStorageData({ storages: ['shadercache'] }))) }, ids)
          const trace = process.env.CATE_BROWSER_LOAD_TRACE && kind === (process.env.CATE_BROWSER_LOAD_TRACE_CASE ?? 'combined') && action === (process.env.CATE_BROWSER_LOAD_TRACE_ACTION ?? 'zoom') && repeat === 0
          if (trace) await app.evaluate(async ({ contentTracing }) => contentTracing.startRecording({ included_categories: ['devtools.timeline', 'cc', 'gpu', 'viz', 'blink.user_timing', 'toplevel', 'skia', 'disabled-by-default-skia.gpu', 'disabled-by-default-gpu.service', 'disabled-by-default-gpu.dawn'] }))
          const samples = [await sample()]
          if (process.env.CATE_BROWSER_LOAD_FREEZE === '1') await app.evaluate(async ({ webContents }, ids) => { await Promise.all(ids.map(id => webContents.fromId(id)!.debugger.sendCommand('Page.setWebLifecycleState', { state: 'frozen' }))) }, ids)
          const timer = setInterval(() => { void sample().then(s => samples.push(s)).catch(() => {}) }, 1000)
          const movement = measureBrowserGesture(page, action)
          await page.waitForFunction(() => (window as unknown as { __loadGestureRunning: boolean }).__loadGestureRunning)
          if (kind !== 'settled') await app.evaluate(({ webContents }, { ids, url }) => { ids.forEach(id => { void webContents.fromId(id)!.loadURL(url).catch(() => {}) }) }, { ids, url: kind === 'github-home' ? 'https://github.com/' : kind === 'github-repository' ? 'https://github.com/microsoft/vscode' : `${origin}/${kind}?run=${Date.now()}` })
          let gesture: Awaited<ReturnType<typeof measureBrowserGesture>>
          try { gesture = await movement } finally { clearInterval(timer) }
          if (process.env.CATE_BROWSER_LOAD_FREEZE === '1') await app.evaluate(async ({ webContents }, ids) => { await Promise.all(ids.map(id => webContents.fromId(id)!.debugger.sendCommand('Page.setWebLifecycleState', { state: 'active' }))) }, ids)
          samples.push(await sample())
          if (trace) await app.evaluate(async ({ contentTracing }, destination) => contentTracing.stopRecording(destination), process.env.CATE_BROWSER_LOAD_TRACE!)
          const guestState = await app.evaluate(async ({ webContents }, ids) => Promise.all(ids.map(async id => { const w = webContents.fromId(id)! as any; return { id, audit: w.__gestureAudit, page: await w.executeJavaScript(`({ loadProfile: window.__loadProfile, readyState: document.readyState, textLength: document.body?.innerText.length, navigation: performance.getEntriesByType('navigation')[0]?.toJSON() })`) } })), ids)
          rows.push({ kind, action, repeat, cache: remote ? (repeat === 0 ? 'cold' : 'warm') : 'no-store', gesture, samples, guestState })
          if (gesture.p95Ms >= 16.7 || gesture.p99Ms >= 25 || gesture.maxMs! >= 25) budgetFailures.push(`${kind}/${action}/${repeat}: p95=${gesture.p95Ms.toFixed(1)} p99=${gesture.p99Ms.toFixed(1)} max=${gesture.maxMs!.toFixed(1)} ms`)
          writeFileSync(process.env.CATE_BROWSER_LOAD_OUTPUT ?? test.info().outputPath('browser-load-gestures.json'), JSON.stringify({ at: new Date().toISOString(), engine, browserCount: ids.length, surfaceDeadline: engine.surfaceDeadline || 'default', imageBytes: image.length, budgetFailures, rows, requests }, null, 2))
          console.log('BROWSER_LOAD', kind, action, repeat, JSON.stringify({ ...gesture, slowFrames: gesture.slowFrames.length }))
          expect(gesture.transformChanged).toBe(true)
        }
      }
    }
    if (process.env.CATE_BROWSER_LOAD_ASSERT_SMOOTH === '1') expect(budgetFailures, 'Browser loading frame budget failures').toEqual([])
  } finally {
    await closeApp(app)
    if (coldBundle) rmSync(coldBundle, { recursive: true, force: true })
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
