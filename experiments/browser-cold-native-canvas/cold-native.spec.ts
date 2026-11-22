import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { createServer } from 'node:http'
import path from 'node:path'
import sharp from 'sharp'
import {paintPage} from './local-paint-page.cjs'
import type { Page } from 'playwright'
import { copyElectronForColdGpuCache } from '../../e2e/fixtures/cold-electron'
import { closeApp, launchApp, seedOnCanvas } from '../../e2e/fixtures/electron-app'
import { act, observe } from '../../e2e/fixtures/browser-control'

async function measureBrowserGesture(page: Page, action: 'pan' | 'zoom', helper: ElectronApplication | null, native: {slot:number;hostOrigin:{x:number;y:number}} | null, durationMs = 5000) {
  const canvas = await page.locator('[data-canvas-container]').boundingBox()
  if (!canvas) throw new Error('Canvas is unavailable')
  const input = helper ? null : await page.context().newCDPSession(page)
  let pending = false
  let inputError: unknown
  let wheelEventsSent = 0
  const interval = input && setInterval(() => {
    if (pending || inputError) return
    pending = true
    const phase = wheelEventsSent++ * .023
    void input.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: canvas.x + 8,
      y: canvas.y + 80,
      modifiers: action === 'zoom' ? 2 : 0, // CDP's Control modifier
      deltaX: action === 'pan' ? 3.1 * Math.cos(phase) : 0,
      deltaY: action === 'pan' ? 2.1 * Math.sin(phase) : .3 * Math.cos(phase),
    }).catch(error => { inputError = error }).finally(() => { pending = false })
  }, 16)
  const routed = helper?.evaluate((_, args) => args.native
    ? (globalThis as any).runNativeFixtureWheels({...args.native,durationMs:args.durationMs})
    : (globalThis as any).runFixtureWheels(args), {
      action, x:Math.round(canvas.x + 8), y:Math.round(canvas.y + 80), durationMs, native,
    })
  try {
    const result = await page.evaluate(async (durationMs) => {
      const w = window as unknown as { __loadGestureRunning: boolean }
      const root = document.querySelector<HTMLElement>('[data-canvas-container]')!
      const world = document.querySelector<HTMLElement>('[data-canvas-world]')!
      const initial = world.style.transform
      const gaps: number[] = [], slowFrames: Array<{ at: number; ms: number }> = []
      let firstInputAt: number | null = null, firstMoveAt: number | null = null
      const observer = new MutationObserver(() => { if (firstInputAt !== null && firstMoveAt === null && world.style.transform !== initial) firstMoveAt = performance.now() })
      observer.observe(world, { attributes: true, attributeFilter: ['style'] })
      const longTasks: number[] = []
      const taskObserver = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)))
      taskObserver.observe({ type: 'longtask' })
      let trustedWheelEvents = 0, modifiedWheelEvents = 0
      const onWheel = (event: WheelEvent) => {
        if (!event.isTrusted) return
        trustedWheelEvents++
        if (event.ctrlKey) modifiedWheelEvents++
        firstInputAt ??= performance.now()
      }
      root.addEventListener('wheel', onWheel, { capture: true, passive: true })
      const started = performance.now()
      performance.mark('browser-load-gesture-start')
      let last = started, raf = 0
      const frame = (now: number) => {
        const ms = now - last
        gaps.push(ms)
        if (ms > 25) { slowFrames.push({ at: now, ms }); performance.measure('browser-load-slow-frame', { start: last, end: now }) }
        last = now
        raf = requestAnimationFrame(frame)
      }
      raf = requestAnimationFrame(frame)
      w.__loadGestureRunning = true
      await new Promise(resolve => setTimeout(resolve, durationMs))
      root.removeEventListener('wheel', onWheel, true)
      cancelAnimationFrame(raf)
      observer.disconnect()
      w.__loadGestureRunning = false
      const elapsedMs = performance.now() - started
      taskObserver.disconnect()
      gaps.sort((a, b) => a - b)
      return { elapsedMs, timeOrigin: performance.timeOrigin, trustedWheelEvents, modifiedWheelEvents, fps: gaps.length * 1000 / elapsedMs, frames: gaps.length, p50Ms: gaps[Math.floor(gaps.length * .5)], p95Ms: gaps[Math.floor(gaps.length * .95)], p99Ms: gaps[Math.floor(gaps.length * .99)], maxMs: gaps.at(-1), slowFrames, firstInputDelayMs: firstInputAt === null || firstMoveAt === null ? null : firstMoveAt - firstInputAt,
        longTasks, transformChanged: world.style.transform !== initial, dpr: devicePixelRatio }
    }, durationMs)
    if (inputError) throw inputError
    const forwarded = routed ? await routed : null
    return { ...result, posted: forwarded?.posted, wheelEventsSent: forwarded?.sent ?? forwarded ?? wheelEventsSent }
  } finally {
    if (interval) clearInterval(interval)
    await input?.detach()
  }
}


test('native Chromium compositing and an animated sibling', async () => {
  const hosted = process.env.PROBE_NATIVE_INPUT === '1'
  const scratch = mkdtempSync('/private/tmp/cate-native-overlay-')
  const profile = path.join(scratch, 'guest-profile')
  const control = path.join(scratch, 'control.sock')
  const secondControl = process.env.PROBE_OVERLAY_SPLIT === '1' ? path.join(scratch, 'second.sock') : ''
  const secondProfile = path.join(scratch, 'second-profile')
  mkdirSync(profile)
  const server = createServer((request, response) => {
    const second = request.url === '/second'
    if (request.url === '/effects') {
      response.setHeader('Content-Type','text/html')
      response.end(paintPage('effects'))
      return
    }
    if (!second) response.setHeader('Set-Cookie', 'overlayProbe=shared; Path=/')
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><title>${second ? 'Second' : 'First'}</title>
      <style>html{background:${second ? '#b04575' : '#09c489'}}body{margin:20px}</style>
      <button onclick="window.trustedClick=event.isTrusted">Activate</button>
      <canvas width="1200" height="700" style="display:block;width:100%;height:420px"></canvas>
      <script>
        window.framesSeen = [];
        const canvas = document.querySelector('canvas');
        const gl = canvas.getContext('webgl2',{alpha:false,antialias:false});
        window.probeGL = gl;
        if (!gl && !${hosted}) throw new Error('WebGL2 is unavailable');
        const ctx = gl ? null : canvas.getContext('2d')
        if(gl) gl.viewport(0,0,canvas.width,canvas.height);
        function update(time) {
          framesSeen.push(performance.timeOrigin + time);
          if(gl) {
            gl.clearColor(.16+.10*Math.sin(time/175),.55,.78,1);
            gl.clear(gl.COLOR_BUFFER_BIT);
          } else {
            ctx.fillStyle='rgb('+Math.round(40+22*Math.sin(time/175))+',140,199)'
            ctx.fillRect(0,0,canvas.width,canvas.height)
          }
          requestAnimationFrame(update);
        }
        if (location.pathname === '/second') requestAnimationFrame(update);
      </script>`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const target = process.env.PROBE_OVERLAY_LIVE === '1' ? 'https://github.com/microsoft/vscode' : origin + '/effects'
  const engine = copyElectronForColdGpuCache(process.env.REPRO_ELECTRON!)
  let app: ElectronApplication | undefined
  let helper: ElectronApplication | undefined
  let secondHelper: ElectronApplication | undefined
  try {
    const main = await launchApp({perf:false, executablePath:engine.executablePath, chromiumArgs:['--enable-features=RawDraw,EnableDrDc'],
      env: {CATE_E2E_BACKGROUND_THROTTLING:'1',PROBE_CONTROL:control,PROBE_SECOND_CONTROL:secondControl}})
    app = main.electronApp
    const page = main.mainWindow
    const hostStyle = process.env.PROBE_HOST_STYLE ?? 'control'
    const focusStyle = hostStyle === 'focus' || hostStyle === 'focus-and-toolbar'
    if (focusStyle) await page.addStyleTag({content:`
      [data-node-id] {
        box-shadow:0 12px 36px -14px rgba(0,0,0,.28), 0 4px 10px -5px rgba(0,0,0,.16) !important;
        transition-property:border-color, transform, opacity, filter !important;
      }
      [data-node-active="true"] { outline:1px solid var(--focus-blue); outline-offset:-1px; }
      [data-glow-for] { visibility:hidden !important; }
      [data-unfocused-overlay], [data-input-frame] { transition-duration:0s !important; }
      [data-browser-toolbar] input[placeholder="Enter a URL"] {
        caret-color:color-mix(in srgb,currentColor 90%,transparent);
      }
      [data-node-id][data-node-active] .dock-tab-bar button { opacity:1 !important; }
    `})
    if (hostStyle === 'focus-and-toolbar') await page.addStyleTag({content:`
      [data-canvas-top-overlay] { visibility:hidden !important; }
      [data-canvas-top-overlay]:has([data-canvas-marquee], [data-panel-target]) { visibility:visible !important; }
      [data-canvas-top-overlay] > :not([data-canvas-top-overlay-world]) {
        visibility:visible;
        will-change:transform;
      }
    `})
    await app.evaluate(({BrowserWindow}) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setSize(1400,950)
      if (window.isVisible()) throw new Error('The host must stay hidden')
    })
    async function launchHelper(profile:string, socket:string) {
      return electron.launch({
        executablePath:engine.executablePath,
        args:[path.join(__dirname,'guest-app')],
        env:{...process.env,PROBE_PROFILE:profile,PROBE_CONTROL:socket,PROBE_ORIGIN:origin,PROBE_REMOTE_TARGET:target},
      })
    }
    helper = await launchHelper(profile,control)
    if (secondControl) {
      mkdirSync(secondProfile)
      secondHelper = await launchHelper(secondProfile,secondControl)
    }
    const otherOwner = secondHelper ?? helper
    const owners = secondHelper ? [helper,secondHelper] : [helper]
    for (const owner of owners) await expect.poll(() => owner.evaluate(() => (globalThis as any).controlReady)).toBe(true)
    await app.evaluate(() => (globalThis as any).connectFixtureBrowser())
    await page.evaluate(() => { window.__cateE2E!.setZoom(.65); window.__cateE2E!.resetViewport() })
    const first = await seedOnCanvas(page,'browser',{x:305,y:290},{url:origin+'/first'})
    const workspaceId = (await page.evaluate(() => window.__cateE2E!.selectedWorkspaceId()))!
    const observePane = async (panelId:string) => {
      try { return await observe(page,{workspaceId,panelId}) }
      catch (error) {
        if (error instanceof Error && error.message.includes('browser-observation-changed-during-capture')) return null
        throw error
      }
    }
    await expect.poll(() => observePane(first.panelId)).toMatchObject({title:'First',url:origin+'/first'})
    const canvasClip = process.env.PROBE_CANVAS_CLIP === '1'
    const second = await seedOnCanvas(page,'browser',{x:canvasClip ? 790 : 1170,y:290},{url:origin+'/second'})
    await expect.poll(() => observePane(second.panelId)).toMatchObject({title:'Second',url:origin+'/second'})

    const helperState = async () => {
      const samples = await Promise.all(owners.map(owner => owner.evaluate(() => (globalThis as any).browserGuestStats())))
      return {
        activeGuests:samples.flatMap(sample => sample.activeGuests),
        errors:samples.flatMap(sample => sample.errors),
      }
    }
    const guests = (await helperState()).activeGuests
    expect(guests).toHaveLength(2)
    expect(guests[0].partition).toBeTruthy()
    if (secondHelper) expect(guests[1].partition).not.toBe(guests[0].partition)
    else expect(guests[1].partition).toBe(guests[0].partition)
    expect(guests.every(({visible}:{visible:boolean})=>!visible)).toBe(true)
    const secondSlot = guests.find(({url}:{url:string})=>url===origin+'/second').slot
    const evaluateGuest = (slot:number,script:string) => (slot === secondSlot ? otherOwner : helper!).evaluate((_,args) => (globalThis as any).evaluateGuest(args.slot,args.script), {slot,script})
    const cookie = await evaluateGuest(secondSlot,'document.cookie')
    if (secondHelper) expect(cookie).not.toContain('overlayProbe=shared')
    else expect(cookie).toContain('overlayProbe=shared')
    const wrapped = process.env.PROBE_WRAPPED_PANES === '1'
    if (wrapped) {
      const point = await evaluateGuest(secondSlot, `(() => {
        const rect = document.querySelector('button').getBoundingClientRect()
        return [rect.x + rect.width / 2, rect.y + rect.height / 2]
      })()`)
      const scale = await evaluateGuest(secondSlot, 'devicePixelRatio')
        / await otherOwner.firstWindow().then(window => window.evaluate(() => devicePixelRatio))
      await otherOwner.evaluate((_, { slot, point, scale }) => (globalThis as any).clickGuest(slot, point[0] * scale, point[1] * scale),
        { slot: secondSlot, point, scale })
    } else {
      const guestPage = otherOwner.windows().find(window => window.url() === origin + '/second')
      expect(guestPage).toBeDefined()
      await guestPage!.getByRole('button',{name:'Activate'}).click()
    }
    await expect.poll(() => evaluateGuest(secondSlot,'window.trustedClick')).toBe(true)
    await expect.poll(() => evaluateGuest(secondSlot,'window.framesSeen.length')).toBeGreaterThan(30)

    const cover = page.locator(`[data-node-id="${first.nodeId}"] [data-unfocused-overlay]`)
    if (await cover.isVisible()) await cover.click({timeout:4000})
    const address = page.locator(`[data-browser-surface="${first.panelId}"]`).getByPlaceholder('Enter a URL')
    await address.fill(target)
    if (focusStyle) {
      const node = page.locator(`[data-node-id="${first.nodeId}"]`)
      await expect(node).toHaveCSS('outline-style','solid')
    }
    if (hostStyle === 'focus-and-toolbar') {
      const overlay = page.locator('[data-canvas-top-overlay]')
      await expect(overlay).toHaveCSS('visibility','hidden')
      await expect(overlay.getByRole('button', {name:'Reset zoom'})).toBeVisible()
    }
    const graphics = (owner:ElectronApplication) => owner.evaluate(({app}) => ({ status:app.getGPUFeatureStatus(), pid:app.getAppMetrics().find(item=>item.type==='GPU')?.pid }))
    const shell = await graphics(app)
    const guest = await graphics(helper)
    expect(shell.pid).toBeDefined()
    expect(guest.pid).toBeDefined()
    expect(shell.pid).not.toBe(guest.pid)
    const otherGuest = await graphics(otherOwner)
    if (secondHelper) {
      expect(otherGuest.pid).toBeDefined()
      expect(otherGuest.pid).not.toBe(guest.pid)
      expect(otherGuest.pid).not.toBe(shell.pid)
    }
    const software = process.env.PROBE_HELPER_SOFTWARE_COMPOSITOR === '1'
    if (!hosted) expect(shell.status).toMatchObject({gpu_compositing:'enabled',rasterization:'enabled',webgl:'enabled'})
    expect(guest.status.gpu_compositing).toBe(software ? 'disabled_software' : 'enabled')

    const time = () => page.evaluate(() => performance.timeOrigin + performance.now())
    await helper.evaluate(({contentTracing}) => contentTracing.startRecording({
      included_categories:['gpu','viz','cc','skia','blink.user_timing','toplevel','disabled-by-default-skia.gpu','disabled-by-default-gpu.service','disabled-by-default-gpu.dawn'],
    }))
    if (process.env.PROBE_CANVAS_CLIP === '1') {
      await app.evaluate(({contentTracing}) => contentTracing.startRecording({
        included_categories:['gpu','viz','cc','skia','blink.user_timing','toplevel','disabled-by-default-skia.gpu','gpu.dawn'],
      }))
    }
    const nativeInput = process.env.PROBE_NATIVE_INPUT === '1'
    const hostOrigin = nativeInput ? await app.evaluate(() => (globalThis as any).showNativeCanvasFixture()) : null
    if (nativeInput) {
      await helper.evaluate(() => (globalThis as any).showNativeGuestWindows())
      await expect.poll(async () => (await helperState()).activeGuests.find(s=>s.slot===secondSlot)?.requestedBounds?.inert).toBe(true)
    }
    const start = await time()
    const action = process.env.PROBE_ACTION === 'zoom' ? 'zoom' : 'pan'
    const forwardInput = process.env.PROBE_FORWARD_WHEELS === '1'
    const movement = measureBrowserGesture(page,action,forwardInput ? helper : null,
      nativeInput ? {slot:secondSlot,hostOrigin} : null)
    await page.waitForFunction(() => (window as any).__loadGestureRunning)
    const animate = process.env.PROBE_MOVING_CLIP === '1'
    if (animate) expect(wrapped).toBe(true)
    const clipAnimation = animate ? helper.evaluate(() => (globalThis as any).animateClips(5000)) : Promise.resolve(null)
    await address.press('Enter')
    const cold = await movement
    const end = await time()
    const clips = await clipAnimation
    if (clips) {
      expect(clips).toHaveLength(2)
      for (const clip of clips) expect(clip.frames).toBeGreaterThan(100)
      await helper.evaluate(() => (globalThis as any).settleClips())
    }
    const label = process.env.PROBE_OVERLAY_LABEL ?? 'stock'
    if (process.env.PROBE_CANVAS_CLIP === '1') {
      await app.evaluate(({contentTracing}, file) => contentTracing.stopRecording(file), path.join(__dirname,`host-${label}.pftrace`))
    }
    await helper.evaluate(({contentTracing},file) => contentTracing.stopRecording(file), path.join(__dirname,`helper-${label}.pftrace`))
    await expect.poll(async ()=>(await observePane(first.panelId))?.url,{timeout:12000}).toBe(target)
    await expect.poll(() => observePane(second.panelId)).toMatchObject({title:'Second',url:origin+'/second'})
    const firstSlot = guests.find(({url}:{url:string})=>url===origin+'/first').slot
    const readLoad = () => evaluateGuest(firstSlot,`(() => {
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      const nav = performance.getEntriesByType('navigation')[0];
      return {firstContentfulPaintMs:fcp?.startTime ?? null, responseStartMs:nav?.responseStart ?? null,
        domContentLoadedMs:nav?.domContentLoadedEventEnd ?? null, timeOrigin:performance.timeOrigin};
    })()`)
    await expect.poll(async ()=>(await readLoad()).firstContentfulPaintMs).not.toBeNull()
    const load = await readLoad()
    if (clips) {
      const paint = load.timeOrigin + load.firstContentfulPaintMs
      for (const clip of clips) {
        expect(paint).toBeGreaterThanOrEqual(clip.startedAt)
        expect(paint).toBeLessThanOrEqual(clip.endedAt)
      }
    }
    const frames = await evaluateGuest(secondSlot,'window.framesSeen') as number[]
    const period = (from:number,to:number) => {
      const samples = frames.filter(at=>at>=from && at<=to)
      const gaps = samples.slice(1).map((at,index)=>at-samples[index]).sort((a,b)=>a-b)
      expect(samples.length).toBeGreaterThan(50)
      return { callbacks:samples.length,maxMs:gaps.at(-1),p95Ms:gaps[Math.floor(gaps.length*.95)],gapsOver25:gaps.filter(ms=>ms>25).length }
    }
    const otherCold = period(start,end)
    const final = await helperState()
    expect(final.errors).toEqual([])
    for (const state of final.activeGuests) {
      expect(state.visible).toBe(nativeInput)
      expect(state.placements).toBeGreaterThan(20)
      for (const edge of ['x','y','width','height']) expect(Math.abs(state.window[edge] - state.requestedBounds[edge])).toBeLessThanOrEqual(1)
    }
    const webgl = await evaluateGuest(secondSlot,`(() => {
      const gl=window.probeGL;
      if(!gl)return null;
      const debug=gl.getExtension('WEBGL_debug_renderer_info');
      return gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER);
    })()`)
    const png = await helper.evaluate((_,slot) => (globalThis as any).captureGuest(slot),secondSlot)
    const screenshot = sharp(Buffer.from(png,'base64'))
    const size = await screenshot.metadata()
    expect(size.width).toBeGreaterThan(10)
    const image = await screenshot.ensureAlpha().raw().toBuffer({resolveWithObject:true})
    const sampled = (x: number, y: number) => {
      const position = (y * image.info.width + x) * 4
      return [...image.data.subarray(position, position + 4)]
    }
    let pixel = sampled(1, 1).slice(0, 3)
    let webglPixel = sampled(200, 220).slice(0, 3)
    let canvasMask: { transparent: number; visible: number } | undefined
    if (canvasClip) {
      const byColor = { transparent: 0, visible: 0 }
      await expect.poll(async () => (await helperState()).activeGuests.some(state => state.clipPaths > 1)).toBe(true)
      expect(final.activeGuests.some(state => state.requestedBounds.clipPath.startsWith('path(evenodd,'))).toBe(true)
      for (let y = 0; y < image.info.height; y += 5) for (let x = 0; x < image.info.width; x += 5) {
        const rgba = sampled(x, y)
        if (rgba[3] === 0) byColor.transparent++
        if (rgba[3] === 255) byColor.visible++
        if (rgba[3] === 255 && rgba[0] === 176 && rgba[1] === 69 && rgba[2] === 117) pixel = rgba.slice(0, 3)
        if (rgba[3] === 255 && rgba[1] === 140 && rgba[2] === 199) webglPixel = rgba.slice(0, 3)
      }
      expect(byColor.visible).toBeGreaterThan(0)
      canvasMask = byColor
      // The foreground pane receives the actual clip at some times, the background at others.
      if (final.activeGuests.find(state => state.slot === secondSlot).appliedClip?.clip.startsWith('path(')) {
        expect(byColor.transparent).toBeGreaterThan(0)
      }
    }
    expect(pixel).toEqual([176,69,117])
    if (!hosted) expect(webgl).toContain('ANGLE Metal Renderer')
    expect(webglPixel[1]).toBeCloseTo(140,0)
    expect(webglPixel[2]).toBeCloseTo(199,0)
    let clippedPixel: number[] | undefined
    if (clips) {
      const capture = () => helper!.evaluate((_,slot) => (globalThis as any).captureGuest(slot), secondSlot)
      await expect.poll(async () => {
        const image = await capture()
        clippedPixel = [...await sharp(Buffer.from(image, 'base64')).extract({left:Math.floor(size.width! * .8),top:Math.floor(size.height! * .4),width:1,height:1}).ensureAlpha().raw().toBuffer()]
        return clippedPixel[3]
      }).toBe(0)
    }
    let routed
    if (forwardInput) {
      const arrivals = await app.evaluate(() => (globalThis as any).fixtureWheelArrivals())
      expect(arrivals.map((entry:any) => entry.id)).toEqual(Array.from({length:cold.wheelEventsSent}, (_,index)=>index))
      expect(cold.trustedWheelEvents).toBeGreaterThan(nativeInput?60:200)
      if (nativeInput) expect(cold.posted).toBeGreaterThan(100)
      expect(cold.modifiedWheelEvents).toBe(action === 'zoom' ? cold.trustedWheelEvents : 0)
      const delays = arrivals.map((x:any)=>x.elapsedMs).sort((a:number,b:number)=>a-b)
      routed = {samples:arrivals.length,p95Ms:delays[Math.floor(delays.length*.95)],maxMs:delays.at(-1)}
    }
    const result = {label,nativeInput,hostStyle,shell,guest,otherGuest,cold,otherCold,final,load,webgl,clips,action,canvasMask,routed,screenshot:{width:size.width,height:size.height,pixel,webglPixel,clippedPixel}}
    writeFileSync(path.join(__dirname,`result-${label}.json`),JSON.stringify(result,null,2))
    console.log('NATIVE_OVERLAY',JSON.stringify({
      trusted:cold.trustedWheelEvents,shellDuringNavigation:cold.maxMs,otherCold,nativePlacements:final.activeGuests.map((item:any)=>item.placements),load,webgl,pixel,webglPixel,
    }))
    expect(cold.trustedWheelEvents).toBeGreaterThan(50)
    expect(cold.transformChanged).toBe(true)
  } finally {
    if (secondHelper) await secondHelper.close()
    if (helper) await helper.close()
    if (app) await closeApp(app)
    server.closeAllConnections()
    await new Promise<void>(resolve=>server.close(()=>resolve()))
    rmSync(scratch,{recursive:true,force:true})
    rmSync(engine.root,{recursive:true,force:true})
  }
})
