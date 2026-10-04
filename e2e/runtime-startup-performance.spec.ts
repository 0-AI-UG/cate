// The paths the per-workspace runtime puts on the critical path: opening a
// workspace whose runtime is not running (the daemon starts), a keystroke's
// round trip through the runtime's PTY to the rendered row, and relaunching
// the app onto a restored workspace (the runtime is started ahead of the
// window). Budgets are tripwires, not hardware targets.

import { test, expect } from '@playwright/test'
import { addCanvas, closeApp, launchApp, makeHome, makeProject, openWorkspace, stopRuntimes } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForPty } from './fixtures/perf-helpers'

test('runtime startup, keystroke round trip and relaunch', async () => {
  const home = makeHome()
  const project = makeProject(home, { git: true, files: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`src/file-${i}.ts`, `export const v${i} = ${i}\n`])) })
  const first = await launchApp({ home, workspace: false, domTerminals: true })
  const { userDataDir } = first
  let { electronApp, mainWindow: page } = first
  try {
    let t0 = performance.now()
    await openWorkspace(page, project)
    const openColdMs = performance.now() - t0
    await addCanvas(page)
    await installPerfHelpers(page)

    t0 = performance.now()
    const term = await create(page, 'terminal', { x: 40, y: 40 })
    await waitForPty(page, term.panelId)
    const terminalMs = performance.now() - t0
    const rows = `[data-node-id="${term.nodeId}"] .xterm-rows`
    await page.waitForFunction((sel) => (document.querySelector(sel)?.textContent ?? '').trim().length > 0, rows, { timeout: 15_000 })

    const echo: number[] = []
    for (let i = 0; i < 20; i++) {
      const marker = `${7000 + i}QZ`
      const seen = page.evaluate(({ sel, marker }) => new Promise<number>((resolve) => {
        const start = performance.now()
        const tick = () => (document.querySelector(sel)?.textContent ?? '').includes(marker) ? resolve(performance.now() - start) : requestAnimationFrame(tick)
        tick()
      }), { sel: rows, marker })
      await page.evaluate(({ id, i }) => window.__cateE2E!.writeTerminal(id, `echo $((7000+${i}))QZ\r`), { id: term.panelId, i })
      echo.push(await seen)
      await page.waitForTimeout(50)
    }
    echo.sort((a, b) => a - b)
    const echoP50 = echo[Math.floor(echo.length / 2)]!
    const echoP90 = echo[Math.floor(echo.length * 0.9)]!

    // Relaunch twice: with the runtime still running, then after it stopped.
    const relaunch: Record<string, number> = {}
    for (const kind of ['runtimeRunning', 'runtimeStopped'] as const) {
      await closeApp(electronApp, { home, keepRuntimes: true })
      if (kind === 'runtimeStopped') stopRuntimes(home)
      t0 = performance.now()
      ;({ electronApp, mainWindow: page } = await launchApp({ home, userDataDir, workspace: false }))
      await installPerfHelpers(page)
      await expect.poll(async () => (await page.evaluate((id) => window.__cateE2E!.terminalText(id).catch(() => ''), term.panelId)).trim().length > 0
        && !!(await page.evaluate((id) => window.__perfE2E!.ptyId(id), term.panelId)), { timeout: 30_000, intervals: [20] }).toBe(true)
      relaunch[kind] = performance.now() - t0
    }

    const round = (n: number) => Math.round(n)
    console.log('runtime startup performance', {
      openColdMs: round(openColdMs),
      terminalMs: round(terminalMs),
      echoP50Ms: round(echoP50),
      echoP90Ms: round(echoP90),
      relaunchRuntimeRunningMs: round(relaunch.runtimeRunning!),
      relaunchRuntimeStoppedMs: round(relaunch.runtimeStopped!),
    })
    expect(openColdMs).toBeLessThan(2_000)
    expect(echoP90).toBeLessThan(60)
    expect(relaunch.runtimeRunning).toBeLessThan(5_000)
    expect(relaunch.runtimeStopped).toBeLessThan(6_000)
  } finally {
    await closeApp(electronApp, { home })
  }
})
