import { test, expect } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { launchApp, closeApp } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForPty } from './fixtures/perf-helpers'

test('canvas pans while the runtime cannot answer activity reports', async () => {
  test.skip(process.platform === 'win32', 'SIGSTOP/SIGCONT require POSIX')
  const { electronApp: app, mainWindow: page, home } = await launchApp()
  let paused: number | null = null
  try {
    await installPerfHelpers(page)
    for (let i = 0; i < 3; i++) {
      const { panelId } = await create(page, 'terminal', { x: 30 + i * 350, y: 40 })
      await waitForPty(page, panelId)
    }
    await page.evaluate(() => { window.__cateE2E!.setZoom(.7); window.__cateE2E!.resetViewport() })
    await page.waitForTimeout(500)
    const runtimeRoot = path.join(home, '.cate', 'workspaces')
    const runtimes = readdirSync(runtimeRoot).map(id => JSON.parse(readFileSync(path.join(runtimeRoot, id, 'runtime.json'), 'utf8')) as { pid: number })
    expect(runtimes).toHaveLength(1)
    paused = runtimes[0].pid
    process.kill(paused, 'SIGSTOP')
    const result = await page.evaluate(async () => {
      let answered = false
      ;(window as any).__pendingActivityReport = window.__cateE2E!.call('presence', 'report', { active: true }).then(() => { answered = true })
      const canvas = document.querySelector<HTMLElement>('[data-canvas-container]')!
      const world = document.querySelector<HTMLElement>('[data-canvas-world]')!
      const initial = world.style.transform
      const started = performance.now()
      const pan = () => canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 4.1, deltaY: .1 }))
      pan()
      const movedInInputTask = world.style.transform !== initial
      const first = world.style.transform
      const firstFrameMs = await new Promise<number>(resolve => requestAnimationFrame(() => resolve(performance.now() - started)))
      for (let i = 0; i < 5; i++) {
        pan()
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      }
      return { movedInInputTask, firstFrameMs, continuedMoving: world.style.transform !== first, reportStillPending: !answered }
    })
    console.log('RUNTIME_PAN_ISOLATION', JSON.stringify(result))
    expect(result.movedInInputTask).toBe(true)
    expect(result.continuedMoving).toBe(true)
    expect(result.reportStillPending).toBe(true)
    process.kill(paused, 'SIGCONT')
    paused = null
    await page.evaluate(() => (window as any).__pendingActivityReport)
  } finally {
    if (paused !== null) { try { process.kill(paused, 'SIGCONT') } catch { /* runtime already exited */ } }
    await closeApp(app)
  }
})

// Profile a client returning with terminal output queued by the runtime.
// Freezing the renderer exercises the backlog without a manual app switch.
test('profile first pan with queued runtime terminal output', async () => {
  test.skip(process.env.CATE_RESUME_STREAM_PROFILE !== '1', 'Opt-in renderer-resume stream measurement')
  const { electronApp: app, mainWindow: page } = await launchApp({ env: { CATE_E2E_BACKGROUND_THROTTLING: '1' } })
  const cdp = await page.context().newCDPSession(page)
  try {
    await app.evaluate(({ app, BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.show(); app.focus({ steal: true }); win.focus() })
    await installPerfHelpers(page)
    const panels: string[] = []
    for (let i = 0; i < 3; i++) {
      const { panelId } = await create(page, 'terminal', { x: 30 + i * 350, y: 40 })
      await waitForPty(page, panelId)
      panels.push(panelId)
    }
    for (const output of [false, true]) {
      await page.evaluate(() => {
        window.__cateE2E!.setZoom(.7); window.__cateE2E!.resetViewport()
        const world = document.querySelector<HTMLElement>('[data-canvas-world]')!
        const initial = world.style.transform
        const result = (window as any).__streamResume = { inputWall: null, frameWall: null, moveWall: null, tasks: [] }
        const input = () => {
          result.inputWall ??= Date.now()
          requestAnimationFrame(() => { result.frameWall ??= Date.now() })
        }
        const observer = new MutationObserver(() => { if (result.inputWall && world.style.transform !== initial) result.moveWall ??= Date.now() })
        observer.observe(world, { attributes: true, attributeFilter: ['style'] })
        const tasks = new PerformanceObserver(list => { for (const task of list.getEntries()) result.tasks.push({ at: task.startTime, ms: task.duration }) })
        tasks.observe({ entryTypes: ['longtask'] })
        document.addEventListener('wheel', input, true)
        ;(window as any).__stopStreamResume = () => { observer.disconnect(); tasks.disconnect(); document.removeEventListener('wheel', input, true); return result }
      })
      if (output) for (const id of panels) await page.evaluate(id => window.__cateE2E!.writeTerminal(id, "sleep .3; for i in {1..18000}; do printf '%s abcdefghijklmnopqrstuvwxyz0123456789 abcdefghijklmnopqrstuvwxyz0123456789\\n' $i; done; echo STREAM-DONE\n"), id)
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
      await cdp.send('Page.setWebLifecycleState', { state: 'frozen' })
      await app.evaluate(() => new Promise(resolve => setTimeout(resolve, 3000)))
      const native = await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        const sent = Date.now()
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 265, y: 180 })
        win.webContents.sendInputEvent({ type: 'mouseWheel', x: 265, y: 180, deltaX: 4.1, deltaY: .1, hasPreciseScrollingDeltas: true })
        return sent
      })
      await cdp.send('Page.setWebLifecycleState', { state: 'active' })
      await page.waitForTimeout(1000)
      const result = await page.evaluate(() => (window as any).__stopStreamResume())
      console.log('STREAM_RESUME_PAN', JSON.stringify({ output, result, inputDelayMs: result.inputWall === null ? null : result.inputWall - native, firstFrameMs: result.frameWall === null ? null : result.frameWall - native }))
      expect(result.inputWall).not.toBeNull()
      await page.waitForTimeout(1500)
    }
  } finally {
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
    await closeApp(app)
  }
})
