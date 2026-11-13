// Opt-in comparison of production canvas culling with real alternate-screen jobs.
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchApp, closeApp } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForPty } from './fixtures/perf-helpers'

test('viewport overscan memory and pan readiness', async () => {
  test.skip(process.env.CATE_OVERSCAN_PROFILE !== '1' || process.platform !== 'darwin', 'Isolated macOS RAM experiment')
  test.setTimeout(300_000)
  const lock = '/private/tmp/cate-ram-round2-profile.lock'
  const owner = JSON.stringify({ track: 'viewport-overscan', pid: process.pid })
  mkdirSync(lock)
  writeFileSync(path.join(lock, 'owner'), owner)
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    launched = await launchApp()
    const { electronApp: app, mainWindow: page, home } = launched
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1600, 1000); w.show(); w.focus() })
    await installPerfHelpers(page)
    await page.evaluate(async () => {
      const stats = { attempts: 0, failures: 0 }
      ;(window as any).__overscanGl = stats
      const original = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (type: string, ...args: any[]) {
        const result = (original as any).call(this, type, ...args)
        if (type === 'webgl2') { stats.attempts++; if (!result) stats.failures++ }
        return result
      } as typeof original
      window.__cateE2E!.setSidebarHidden(true)
      await window.__cateE2E!.call('settings', 'set', { key: 'autoSuspendIdleTerminals', value: false })
      window.__cateE2E!.setZoom(1)
    })
    const ids: string[] = [], ptys: string[] = []
    for (let row = 0; row < 6; row++) for (let col = 0; col < 8; col++) {
      const { panelId } = await create(page, 'terminal', { x: col * 660, y: row * 420 })
      ids.push(panelId)
      ptys.push(await waitForPty(page, panelId))
    }
    const script = String.raw`
process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.write('\x1b[?1049h\x1b[?1h');
let tick=0, input='';
function draw() { let rows=process.stdout.rows||24; process.stdout.write('\x1b[H\x1b[2J\x1b[32mAGENT-TUI tick='+ ++tick +'\x1b[0m\r\nINPUT='+input+'\r\n'+Array.from({length:Math.max(1,rows-4)},(_,i)=>'task '+i+' running tools and checking files 界 ✓').join('\r\n')); }
process.stdin.on('data', b=>{input=Buffer.from(b).toString('hex');draw()});
setInterval(draw,200); draw();
`
    const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'"
    const command = `${quote(process.execPath)} -e ${quote(script)}\n`
    await Promise.all(ids.map(id => page.evaluate(({ id, command }) => window.__cateE2E!.writeTerminal(id, command), { id, command })))
    await expect.poll(async () => page.evaluate(async ptys => {
      const screens = await Promise.all(ptys.map(id => window.__cateE2E!.call('process', 'read', { id }))) as Array<{ alt: boolean; text: string }>
      return screens.filter(s => s.alt && s.text.includes('AGENT-TUI')).length
    }, ptys), { timeout: 30000 }).toBe(48)
    const statuses = () => page.evaluate(() => window.__cateE2E!.call('process', 'list')) as Promise<Array<{ id: string; pid: number; alive: boolean; suspended: boolean }>>
    const before = await statuses()
    await page.evaluate(() => {
      // Read view-owned xterms without retaining disposed views in the harness.
      const terms = () => {
        const result = new Map<string, { buffer: { active: { getLine(i: number): { translateToString(trim: boolean): string } | undefined } } }>()
        for (const el of document.querySelectorAll('[data-terminal-render-box]')) {
          const nodeId = el.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId
          let fiber = (el as unknown as Record<string, unknown>)[Object.keys(el).find(k => k.startsWith('__reactFiber'))!] as any
          while (fiber && nodeId && !result.has(nodeId)) {
            let hook = fiber.memoizedState
            while (hook && typeof hook === 'object') {
              const value = hook.memoizedState?.current
              if (value?.terminal?.buffer) { result.set(nodeId, value.terminal); break }
              hook = hook.next
            }
            fiber = fiber.return
          }
        }
        return result
      }
      ;(window as any).__overscan = {
        terms,
        async pan({ x, y, dx, frames }: { x: number; y: number; dx: number; frames: number }) {
          const samples = []
          let previous = performance.now()
          for (let frame = 0; frame < frames; frame++) {
            x += dx
            window.__cateE2E!.setViewport({ x, y })
            await new Promise(requestAnimationFrame)
            const at = performance.now()
            const box = document.querySelector('[data-canvas-container]')!.getBoundingClientRect()
            const expected = window.__cateE2E!.nodes().filter(n => n.origin.x + n.size.width + x > 0 && n.origin.x + x < box.width && n.origin.y + n.size.height + y > 0 && n.origin.y + y < box.height)
            const mounted = terms()
            const missing = expected.filter(n => !mounted.get(n.id)?.buffer.active.getLine(0)?.translateToString(true).includes('AGENT-TUI')).map(n => n.id)
            samples.push({ dt: at - previous, expected: expected.length, mounted: mounted.size, missing: missing.length })
            previous = at
          }
          return samples
        },
      }
    })
    const samples: unknown[] = []
    const sample = async (stage: string) => {
      await page.waitForTimeout(2000)
      const metrics = await app.evaluate(({ app }) => app.getAppMetrics())
      const runtimeRoot = path.join(home, '.cate/workspaces')
      const runtime = JSON.parse(readFileSync(path.join(runtimeRoot, readdirSync(runtimeRoot)[0], 'runtime.json'), 'utf8'))
      const processes = [...metrics.filter(m => ['Tab', 'GPU'].includes(m.type)).map(m => ({ pid: m.pid, type: m.type })), { pid: runtime.pid, type: 'runtime' }]
      const memory = processes.map(p => {
        const raw = execFileSync('/usr/bin/footprint', ['-f', 'bytes', '-p', String(p.pid)], { encoding: 'utf8', timeout: 15000 })
        return { ...p, bytes: Number(raw.match(/phys_footprint: (\d+) B/)![1]), raw }
      })
      const mounted = await page.locator('.xterm').count()
      samples.push({ stage, mounted, memory })
      console.log('OVERSCAN_MEMORY', stage, mounted, JSON.stringify(memory.map(({ raw: _raw, ...m }) => m)))
    }
    await page.evaluate(() => window.__cateE2E!.setViewport({ x: -1980, y: -840 }))
    await page.waitForTimeout(3000)
    await sample('settled-1'); await sample('settled-2'); await sample('settled-3')
    const pan = (dx: number, frames: number, x: number) => page.evaluate(arg => (window as any).__overscan.pan(arg), { x, y: -840, dx, frames }) as Promise<Array<{ dt: number; missing: number }>>
    const slow = await pan(-15, 90, -1980)
    await page.waitForTimeout(1000)
    const fast = await pan(60, 45, -3330)
    await page.waitForTimeout(1000)
    await page.evaluate(() => window.__cateE2E!.setViewport({ x: -1980, y: -840 }))
    await sample('after-pan-1'); await sample('after-pan-2'); await sample('after-pan-3')
    const repeatedPans = []
    if (process.env.CATE_OVERSCAN_SOAK === '1') for (let round = 0; round < Number(process.env.CATE_OVERSCAN_ROUNDS ?? 8); round++) {
      repeatedPans.push({ slow: await pan(-15, 90, -1980), fast: await pan(60, 45, -3330) })
      await page.evaluate(() => window.__cateE2E!.setViewport({ x: -1980, y: -840 }))
      await sample(`repeat-${round + 1}`)
    }
    let heapDiagnostic
    if (process.env.CATE_OVERSCAN_GC_DIAGNOSTIC === '1') {
      const cdp = await page.context().newCDPSession(page)
      const before = await cdp.send('Runtime.getHeapUsage')
      await cdp.send('HeapProfiler.collectGarbage')
      await cdp.send('HeapProfiler.collectGarbage')
      const after = await cdp.send('Runtime.getHeapUsage')
      heapDiagnostic = { before, after }
      await sample('diagnostic-gc-only')
    }
    const mountedNode = page.locator('[data-node-id]').filter({ has: page.locator('.xterm textarea') })
    // Input after repeated mounts still reaches a live process.
    const chosen = await page.evaluate(() => {
      const box = document.querySelector('[data-canvas-container]')!.getBoundingClientRect()
      return window.__cateE2E!.nodes().find(n => n.origin.x - 1980 >= 0 && n.origin.x - 1980 + n.size.width <= box.width && n.origin.y - 840 >= 0 && n.origin.y - 840 + n.size.height <= box.height)!
    })
    expect(await mountedNode.count()).toBeGreaterThan(0)
    await page.locator(`[data-node-id="${chosen.id}"] .xterm textarea`).focus()
    await page.keyboard.type('z')
    await expect.poll(() => page.evaluate(id => window.__cateE2E!.terminalText(id), chosen.panelId)).toContain('INPUT=7a')
    await expect.poll(() => page.evaluate(id => (window as any).__overscan.terms().get(id)?.buffer.active.getLine(1)?.translateToString(true), chosen.id)).toContain('INPUT=7a')
    const after = await statuses()
    expect(after.map(s => [s.id, s.pid])).toEqual(before.map(s => [s.id, s.pid]))
    expect(after.every(s => s.alive && !s.suspended)).toBe(true)
    const captureState = process.env.CATE_OVERSCAN_SCREENSHOT === '1' ? await app.evaluate(({ app, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const before = { visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized() }
      win.show(); win.focus(); app.focus({ steal: true })
      return { before, after: { visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized() } }
    }) : null
    const result = { variant: process.env.CATE_OVERSCAN_VARIANT, samples, slow, fast, repeatedPans, heapDiagnostic, captureState, gl: await page.evaluate(() => (window as any).__overscanGl), ptys: before.map(s => ({ id: s.id, pid: s.pid })), inputAfterPan: true }
    writeFileSync(test.info().outputPath('overscan.json'), JSON.stringify(result, null, 2))
    if (process.env.CATE_OVERSCAN_SCREENSHOT === '1') await page.screenshot({ path: test.info().outputPath('viewport.png') })
  } finally {
    try { if (launched) await closeApp(launched.electronApp) }
    finally { if (readFileSync(path.join(lock, 'owner'), 'utf8') === owner) rmSync(lock, { recursive: true }) }
  }
})
