import { expect, test } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { closeApp, launchApp } from './fixtures/electron-app'
import { openTrustedWorkspace } from './fixtures/workspace'

// Opt in: CATE_E2E_SOAK=1 npx playwright test e2e/session-soak-perf.spec.ts
// CATE_E2E_SOAK_SECONDS extends the run. Optional BROWSER, VISIBLE, RECOVERY,
// KEEP_AWAKE, and HOOKS flags under CATE_E2E_SOAK_ exercise additional paths.
// Deliberately no CATE_PERF: its perpetual rAF changes Chromium's RAF/JSAnimation
// tracker lifetime. Keep the production lifecycle while measuring resource use.
test('session resource use stays bounded through repeated terminal and canvas activity', async () => {
  test.skip(!process.env.CATE_E2E_SOAK, 'Opt-in native compositor soak')
  const durationMs = Number(process.env.CATE_E2E_SOAK_SECONDS ?? 180) * 1000
  test.setTimeout(durationMs + 120_000)
  let app: ElectronApplication | undefined
  const roots: string[] = []
  const samples: Array<Record<string, number>> = []
  try {
    const launched = await launchApp({ env: {
      CATE_PERF: '0',
      ...(process.env.CATE_E2E_SOAK_RUNTIME ? { CATE_E2E_RUNTIME_BUNDLE: process.env.CATE_E2E_SOAK_RUNTIME } : {}),
    } })
    app = launched.electronApp
    const page = launched.mainWindow
    if (process.env.CATE_E2E_SOAK_HOOKS) {
      await page.evaluate(() => window.electronAPI.settingsSet('notificationsEnabled', false))
      await app.evaluate(({ BrowserWindow }) => {
        const counts = { running: 0, waiting: 0 }
        const win = BrowserWindow.getAllWindows()[0]
        win.webContents.on('ipc-message', (_event, channel, _id, state) => {
          if (channel !== 'shell:agentScreenState') return
          if (state === 'running') counts.running++
          if (state === 'waitingForInput') counts.waiting++
        })
        ;(globalThis as unknown as { cateHookSoak: typeof counts }).cateHookSoak = counts
      })
    }
    app.process().once('exit', (code, signal) => console.log('soak process exit', { code, signal }))
    page.on('crash', () => console.log('soak renderer crashed'))
    if (process.env.CATE_E2E_SOAK_VISIBLE) {
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        win.setSize(800, 600)
        win.showInactive()
      })
    }
    await page.evaluate(() => window.electronAPI.settingsSet('terminalCursorBlink', true))
    if (process.env.CATE_E2E_SOAK_KEEP_AWAKE) {
      expect(await page.evaluate(() => window.electronAPI.setKeepAwake(30))).toMatchObject({ enabled: true })
    }
    expect(await page.evaluate(() => window.__catePerf)).toBeUndefined()
    // Preserve production CSS animation/transition behavior for this test.
    await page.evaluate(() => document.querySelector('[data-cate-e2e-no-animations]')?.remove())
    const version = await app.evaluate(() => process.versions)
    console.log('soak engine', version.electron, version.chrome)
    const workspaces: Array<{ id: string; node: string }> = []
    for (let index = 0; index < 2; index++) {
      if (index) {
        const id = await page.evaluate(() => window.__cateE2E!.addWorkspace('Soak B'))
        await page.evaluate(id => window.__cateE2E!.selectWorkspace(id), id)
      }
      const root = mkdtempSync(path.join(tmpdir(), 'cate-soak-project-'))
      roots.push(root)
      await openTrustedWorkspace(page, root)
      if (await page.locator('[data-canvas-panel-id]').count() === 0) {
        await page.evaluate(() => window.__cateE2E!.createPanel('canvas'))
        await page.waitForSelector('[data-canvas-panel-id]')
      }
      const node = await page.evaluate(() => window.__cateE2E!.createTerminal({ x: 30, y: 30 }))
      await expect.poll(() => page.evaluate(id => window.__cateE2E!.terminalPtyId(id), node)).not.toBeNull()
      const id = await page.evaluate(() => window.__cateE2E!.selectedWorkspaceId())
      workspaces.push({ id, node })
      if (process.env.CATE_E2E_SOAK_BROWSER) {
        const browser = await page.evaluate(() => window.__cateE2E!.createBrowser(
          `data:text/html,${encodeURIComponent('<title>Soak browser</title><canvas width="400" height="200"></canvas><script>const c=document.querySelector("canvas").getContext("2d");let n=0;setInterval(()=>{c.fillStyle=++n%2?"#345":"#456";c.fillRect(0,0,400,200)},60)</script>')}`,
          { x: 400, y: 30 },
        ))
        await expect.poll(() => page.evaluate(id => window.__cateE2E!.browserWebContentsId(id), browser.panelId)).not.toBeNull()
      }
      // A real PTY stream with pauses between updates, like an agent TUI. No
      // unbounded scrollback and no child process per output tick.
      const script = `let n=0;const t=setInterval(()=>process.stdout.write('\\rsoak-tick-'+(++n)+'\\x1b[K'),60);setTimeout(()=>{clearInterval(t);process.exit()},${durationMs + 90_000})`
      const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
      let command = `${quote(process.execPath)} -e ${quote(script)}\n`
      if (process.env.CATE_E2E_SOAK_HOOKS) {
        const fixtureNode = path.join(root, process.platform === 'win32' ? 'codex.exe' : 'codex')
        // Use a standalone Node binary on macOS; Homebrew's launcher depends
        // on a libnode path relative to its original installation.
        copyFileSync(process.env.CATE_E2E_SOAK_NODE ?? process.execPath, fixtureNode)
        command = `${quote(fixtureNode)} ${quote(path.resolve(__dirname, 'fixtures/codex-hook-workload.mjs'))} ${durationMs + 90_000}\n`
      }
      expect(await page.evaluate(({ node, command }) => window.__cateE2E!.writeTerminal(node, command), { node, command })).toBe(true)
      await expect.poll(() => page.evaluate(node => window.__cateE2E!.terminalText(node), node)).toMatch(/soak-tick-\d+/)
    }

    const rendererPid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId())
    console.log('soak renderer PID', rendererPid)
    const resources = () => app!.evaluate(({ app }, pid) => {
      const metrics = app.getAppMetrics()
      const renderer = metrics.find(m => m.pid === pid)!
      return {
        at: Date.now(),
        cpuSeconds: renderer.cpu.cumulativeCPUUsage!,
        memoryMB: renderer.memory.workingSetSize / 1024,
        totalMemoryMB: metrics.reduce((sum, m) => sum + m.memory.workingSetSize / 1024, 0),
      }
    }, rendererPid)
    const cdp = await page.context().newCDPSession(page)
    await page.waitForTimeout(5000)
    if (process.env.CATE_E2E_SOAK_HOOKS) {
      await expect.poll(() => app!.evaluate(() => (globalThis as unknown as { cateHookSoak: { running: number } }).cateHookSoak.running)).toBeGreaterThan(0)
    }
    const measure = async (elapsed: number) => {
      const before = await resources()
      await page.waitForTimeout(3000)
      const after = await resources()
      const dom = await cdp.send('Memory.getDOMCounters')
      const frameMs = await page.evaluate(async () => {
        const start = performance.now()
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        return performance.now() - start
      })
      const sample = {
        elapsed, cpu: 100_000 * (after.cpuSeconds - before.cpuSeconds) / (after.at - before.at),
        memoryMB: after.memoryMB, totalMemoryMB: after.totalMemoryMB,
        nodes: dom.nodes, listeners: dom.jsEventListeners, frameMs,
      }
      samples.push(sample)
      console.log('soak', JSON.stringify(sample))
      // Stop this isolated workload if it threatens the host's available RAM.
      expect(sample.totalMemoryMB).toBeLessThan(2000)
    }
    await measure(0)
    if (process.env.CATE_E2E_SOAK_RECOVERY) {
      await app.evaluate(({ app }) => {
        const gpu = app.getAppMetrics().find(m => m.type === 'GPU')
        if (!gpu) throw new Error('No isolated GPU process found')
        process.kill(gpu.pid, 'SIGKILL')
      })
      await page.waitForTimeout(3000)
    }
    const started = Date.now()
    let cycle = 0
    let nextSample = 30_000
    while (Date.now() - started < durationMs) {
      const workspace = workspaces[cycle++ % workspaces.length]
      await page.evaluate(id => window.__cateE2E!.selectWorkspace(id), workspace.id)
      await page.waitForFunction(node => window.__cateE2E!.nodes().some(n => n.id === node), workspace.node)
      await page.evaluate(cycle => {
        const h = window.__cateE2E!
        // Alternate each workspace's own transform, not just the two workspaces.
        const shifted = Math.floor(cycle / 2) % 2 === 1
        h.setZoom(shifted ? 0.8 : 1)
        h.setViewport({ x: shifted ? 150 : 0, y: shifted ? 80 : 0 })
      }, cycle)
      if (cycle % 8 === 0) {
        await page.locator('.xterm-helper-textarea').first().focus()
        await page.keyboard.type('a')
        await page.keyboard.press('Backspace')
      }
      await page.waitForTimeout(400)
      if (process.env.CATE_E2E_SOAK_VISIBLE && cycle % 20 === 0) {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
        await page.waitForTimeout(200)
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
      }
      if (Date.now() - started >= nextSample) {
        await measure(Date.now() - started)
        nextSample += 30_000
      }
    }
    await measure(Date.now() - started)
    if (process.env.CATE_E2E_SOAK_HOOKS) {
      const counts = await app.evaluate(() => (globalThis as unknown as { cateHookSoak: { running: number; waiting: number } }).cateHookSoak)
      console.log('hook status transitions', counts)
      expect(counts.running).toBeGreaterThan(100)
      expect(counts.waiting).toBeGreaterThan(100)
    }
    const baseline = samples[0]
    const tail = samples.slice(-3)
    const mean = (key: string) => tail.reduce((sum, sample) => sum + sample[key], 0) / tail.length
    expect(mean('cpu') - baseline.cpu, 'renderer CPU must not grow by a substantial fraction of one core').toBeLessThan(20)
    expect(mean('memoryMB') - baseline.memoryMB, 'renderer resident memory growth must remain bounded').toBeLessThan(128)
    expect(mean('frameMs'), 'a short animation must remain responsive').toBeLessThan(100)
  } finally {
    if (app) await closeApp(app)
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    await test.info().attach('session-soak.json', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' })
  }
})
