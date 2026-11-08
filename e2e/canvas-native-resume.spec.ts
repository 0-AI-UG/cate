// Opt-in harness for OS-level Cmd+Tab and scroll/drag through computer use.
// The runner does not poll the renderer or schedule frames while it is idle.
import { test, expect } from '@playwright/test'
import { existsSync, writeFileSync } from 'node:fs'
import { launchApp, closeApp } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForPty } from './fixtures/perf-helpers'

test('record native application return and immediate pan', async () => {
  test.skip(process.env.CATE_NATIVE_RESUME !== '1', 'Opt-in manual OS input recording')
  test.setTimeout(660_000)
  const { electronApp: app, mainWindow: page } = await launchApp({ env: { CATE_E2E_BACKGROUND_THROTTLING: '1' } })
  try {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    await app.evaluate(async ({ app, BrowserWindow }) => {
      await app.dock?.show()
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(1400, 950); win.show(); win.focus()
    })
    await installPerfHelpers(page)
    for (let i = 0; i < 4; i++) {
      const { panelId } = await create(page, 'terminal', { x: 40 + i % 2 * 610, y: 30 + Math.floor(i / 2) * 410 })
      await waitForPty(page, panelId)
    }
    await page.evaluate(() => { window.__cateE2E!.setZoom(.7); window.__cateE2E!.resetViewport() })
    await page.locator('[data-unfocused-overlay]').first().click()
    await page.evaluate(() => {
      const w = window as any
      const world = document.querySelector<HTMLElement>('[data-canvas-world]')!
      const events: unknown[] = w.__nativeResumeEvents = []
      const record = (kind: string, extra = {}) => events.push({ kind, at: performance.now(), wall: Date.now(), ...extra })
      window.addEventListener('focus', () => record('focus'))
      window.addEventListener('blur', () => record('blur'))
      document.addEventListener('visibilitychange', () => record('visibility', { state: document.visibilityState }))
      let raf = 0, lastInput = 0
      const frame = () => {
        record('frame', { transform: world.style.transform })
        raf = performance.now() - lastInput < 1000 ? requestAnimationFrame(frame) : 0
      }
      const input = (e: MouseEvent | WheelEvent) => {
        if (e.type === 'mousemove' && !e.buttons) return
        lastInput = performance.now()
        record(e.type, { eventTime: e.timeStamp, inputAge: performance.now() - e.timeStamp, x: e.clientX, y: e.clientY, buttons: e.buttons, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, target: (e.target as Element)?.tagName,
          deltaX: 'deltaX' in e ? e.deltaX : undefined, deltaY: 'deltaY' in e ? e.deltaY : undefined })
        if (!raf) raf = requestAnimationFrame(frame)
      }
      for (const name of ['wheel', 'mousedown', 'mousemove', 'mouseup']) document.addEventListener(name, input as EventListener, true)
      new MutationObserver(() => record('transform', { transform: world.style.transform })).observe(world, { attributes: true, attributeFilter: ['style'] })
      new PerformanceObserver(list => { for (const entry of list.getEntries()) record('longtask', { start: entry.startTime, duration: entry.duration }) }).observe({ entryTypes: ['longtask'] })
      record('ready')
    })
    console.log('NATIVE_RESUME_READY', await app.evaluate(({ app }) => ({ pid: process.pid, executable: app.getPath('exe') })))
    const stop = process.env.CATE_NATIVE_RESUME_STOP ?? '/private/tmp/cate-native-resume-stop'
    const end = Date.now() + 600_000
    while (!existsSync(stop) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 500))
    const events = await page.evaluate(() => (window as any).__nativeResumeEvents)
    writeFileSync(process.env.CATE_NATIVE_RESUME_OUTPUT ?? test.info().outputPath('native-resume.json'), JSON.stringify(events, null, 2))
    expect(events.some((e: { kind: string }) => e.kind === 'wheel' || e.kind === 'mousemove')).toBe(true)
  } finally { await closeApp(app) }
})
