// Native app activation + input latency. macOS-only and opt-in.
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { launchApp, closeApp } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForBrowserGuest, waitForPty } from './fixtures/perf-helpers'

test('first canvas pan after macOS application activation', async () => {
  test.skip(process.env.CATE_ACTIVATION_PROFILE !== '1' || process.platform !== 'darwin', 'Opt-in real macOS application activation')
  test.setTimeout(600_000)
  const asn = (text: string) => text.match(/ASN:0x[\da-f]+-0x[\da-f]+/i)?.[0]
  const original = asn(execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }))
  const finder = asn(execFileSync('/usr/bin/lsappinfo', ['find', 'bundleID=com.apple.finder'], { encoding: 'utf8' }))
  expect(finder, 'Finder is available as the other application').toBeTruthy()
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.url === '/slow.svg') { res.setHeader('Content-Type', 'image/svg+xml'); setTimeout(() => res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'), 3500); return }
    res.setHeader('Content-Type', 'text/html')
    res.end(`<title>Activation load</title><img src="/slow.svg"><div id="rows"></div><script>setTimeout(()=>{const p=document.querySelector('#rows');p.innerHTML='<div><button>Loading row</button></div>'.repeat(16000);const end=performance.now()+3000;function frame(){const s=performance.now();while(performance.now()-s<10){};p.style.width=(900+Math.random()*10)+'px';void p.offsetHeight;if(performance.now()<end)requestAnimationFrame(frame)}requestAnimationFrame(frame)},300)</script>`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/loading`
  const { electronApp: app, mainWindow: page } = await launchApp({ chromiumArgs: process.env.CATE_BROWSER_LOAD_SURFACE_DEADLINE === undefined ? [] : [`--deadline-to-synchronize-surfaces=${process.env.CATE_BROWSER_LOAD_SURFACE_DEADLINE}`], env: { CATE_E2E_BACKGROUND_THROTTLING: '1' } })
  const rows: unknown[] = []
  let guestId: number | null = null
  try {
    // Playwright normally pretends the page stays focused even when another
    // macOS application is active. That hides the resume path under test.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    await app.evaluate(async ({ app, BrowserWindow }) => { await app.dock?.show(); const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 950); w.show(); w.focus() })
    await installPerfHelpers(page)
    const engine = await app.evaluate(({ app }) => ({ appVersion: app.getVersion(), versions: process.versions, executable: app.getPath('exe') }))
    const scheduling = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLElement>('[data-canvas-container]')!
      const world = document.querySelector<HTMLElement>('[data-canvas-world]')!
      const before = world.style.transform
      canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 4.1, deltaY: .1 }))
      return { movedInInputTask: world.style.transform !== before }
    })
    for (const scenario of (process.env.CATE_ACTIVATION_CASES ?? 'empty,browser-settled,browser-loading').split(',')) {
      if (scenario === 'terminals') {
        for (let i = 0; i < 4; i++) {
          const { panelId } = await create(page, 'terminal', { x: 30 + i % 2 * 600, y: 30 + Math.floor(i / 2) * 400 })
          await waitForPty(page, panelId)
        }
        await page.locator('[data-unfocused-overlay]').first().click()
        await page.locator('.xterm').first().click()
      }
      if (scenario.startsWith('browser') && guestId === null) {
        const { panelId } = await create(page, 'browser', { x: 300, y: 60 }, { url: 'data:text/html,<title>Activation settled</title><h1>Settled</h1>' })
        guestId = await waitForBrowserGuest(page, panelId)
      }
      for (const delayMs of (process.env.CATE_ACTIVATION_DELAYS ?? '0,50,200').split(',').map(Number)) {
        for (const action of (process.env.CATE_ACTIVATION_ACTIONS ?? 'wheel,drag').split(',')) {
          for (let repeat = 0; repeat < Number(process.env.CATE_ACTIVATION_REPEATS ?? 2); repeat++) {
            await page.waitForFunction(() => !document.body.classList.contains('canvas-interacting'))
            if (guestId !== null) await app.evaluate(async ({ webContents }, id) => { await webContents.fromId(id)!.loadURL('data:text/html,<title>Settled</title><h1>Settled</h1>') }, guestId)
            await page.evaluate(() => { window.__cateE2E!.setZoom(.8); window.__cateE2E!.resetViewport() })
            await page.waitForTimeout(500)
            const point = await page.evaluate(() => {
              const w = window as any
              w.__stopActivation?.()
              const root = document.querySelector<HTMLElement>('[data-canvas-container]')!
              const world = document.querySelector<HTMLElement>('[data-canvas-world]')!
              const initial = world.style.transform
              const p = w.__activationProbe = { focusAt: null, inputAt: null, inputWall: null, moveAt: null, inputEvents: 0, firstFrameAt: null, firstMovingFrameAt: null, frames: [] }
              const focus = () => { p.focusAt = performance.now() }
              const input = (event: Event) => { if (event.type === 'mousemove' && !(event as MouseEvent).buttons) return; p.inputEvents++; if (p.inputAt === null) { p.inputAt = performance.now(); p.inputWall = Date.now(); raf = requestAnimationFrame(frame) } }
              window.addEventListener('focus', focus)
              root.addEventListener('wheel', input, true); root.addEventListener('mousemove', input, true)
              const observer = new MutationObserver(() => { if (p.inputAt !== null && p.moveAt === null && world.style.transform !== initial) p.moveAt = performance.now() })
              observer.observe(world, { attributes: true, attributeFilter: ['style'] })
              let raf = 0, previous: number | null = null
              const frame = (now: number) => { if (p.inputAt !== null) { p.firstFrameAt ??= performance.now(); if (p.moveAt !== null) p.firstMovingFrameAt ??= performance.now(); if (previous !== null) p.frames.push(now - previous); previous = now } raf = requestAnimationFrame(frame) }
              w.__stopActivation = () => { cancelAnimationFrame(raf); observer.disconnect(); window.removeEventListener('focus', focus); root.removeEventListener('wheel', input, true); root.removeEventListener('mousemove', input, true) }
              const rect = root.getBoundingClientRect()
              return { x: Math.round(rect.left + 8), y: Math.round(rect.top + 120) }
            })
            if (scenario === 'browser-loading') await app.evaluate(({ webContents }, { id, url }) => { void webContents.fromId(id!)!.loadURL(url).catch(() => {}) }, { id: guestId, url })
            execFileSync('/usr/bin/open', ['-a', 'Finder'])
            await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(false)
            await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false)
            await page.waitForTimeout(Number(process.env.CATE_ACTIVATION_AWAY_MS ?? 10000))
            const native = await app.evaluate(({ app, BrowserWindow }, { point, delayMs, action }) => new Promise<{ focusWall: number; inputWall: number }>(resolve => {
              const win = BrowserWindow.getAllWindows()[0]
              const focused = () => {
                const focusWall = Date.now()
                setTimeout(() => {
                  const inputWall = Date.now()
                  let step = 0
                  if (action === 'drag') win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'middle', clickCount: 1 })
                  const send = () => {
                    step++
                    if (action === 'wheel') win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: 4.1, deltaY: .1, hasPreciseScrollingDeltas: true })
                    else win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + step * 3, y: point.y, button: 'middle', modifiers: ['middleButtonDown'] })
                  }
                  send(); const timer = setInterval(send, 16)
                  setTimeout(() => { clearInterval(timer); if (action === 'drag') win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + step * 3, y: point.y, button: 'middle', clickCount: 1 }); resolve({ focusWall, inputWall }) }, 600)
                }, delayMs)
              }
              win.once('focus', focused); app.focus({ steal: true }); win.focus()
            }), { point, delayMs, action })
            await page.waitForTimeout(400)
            const probe = await page.evaluate(() => { const w = window as any; w.__stopActivation(); return { ...w.__activationProbe, focused: document.hasFocus(), bodyClasses: document.body.className } })
            const result = { scenario, action, repeat, delayMs, native, probe, deliveryMs: probe.inputWall === null ? null : probe.inputWall - native.inputWall, inputToMoveMs: probe.inputAt === null || probe.moveAt === null ? null : probe.moveAt - probe.inputAt }
            rows.push(result)
            writeFileSync(process.env.CATE_ACTIVATION_OUTPUT ?? test.info().outputPath('activation-pan.json'), JSON.stringify({ at: new Date().toISOString(), otherApp: 'Finder', engine, scheduling, rows }, null, 2))
            console.log('ACTIVATION_PAN', JSON.stringify({ scenario, action, repeat, delayMs, deliveryMs: result.deliveryMs, inputToMoveMs: result.inputToMoveMs, events: probe.inputEvents }))
            expect(probe.moveAt, 'native pan input moves the world').not.toBeNull()
          }
        }
      }
    }
  } finally {
    await closeApp(app)
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    if (original) execFileSync('/usr/bin/lsappinfo', ['setfront', original])
  }
})
