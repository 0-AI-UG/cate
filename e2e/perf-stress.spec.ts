// =============================================================================
// Performance stress test — drives the app under load and measures the cost.
//
// Unlike the other specs, this launches with CATE_PERF=1 so the resource
// profiler is active (main getAppMetrics sampler + spawn/IPC/terminal counters,
// renderer FPS / long-task / render counters, exposed via window.__catePerf).
//
// Each scenario brackets a load action with measure() and reports:
//   - renderer FPS and long tasks (>50ms main-thread blocks = visible jank)
//   - renders/sec for the hot components (CanvasNode, ChatThread, ...)
//   - main-process per-process CPU/mem + terminal throughput + subprocess spawns
//
// The thresholds asserted here are deliberately GENEROUS — they only catch
// egregious regressions (multi-second freezes, sub-20fps drags, a flood that
// didn't actually flood). The point is the printed report, which makes the cost
// of each path visible and gives before/after numbers for the audit fixes.
//
// Run:  npm run build && npx playwright test e2e/perf-stress.spec.ts
// =============================================================================

import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './fixtures/electron-app'
import type { ElectronApplication, Page } from 'playwright'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp({ perf: true }))
  // Confirm the profiler is actually live before any scenario runs.
  await page.waitForFunction(() => typeof window.__catePerf === 'object', { timeout: 15_000 })
  expect(await page.evaluate(() => window.__catePerf!.longTasksSupported())).toBe(true)

})

test.afterAll(async () => { if (app) await closeApp(app) })

test.afterEach(async () => {
  const testInfo = test.info()
  if (!page || page.isClosed()) return
  const metrics = await page.evaluate(async () => ({
    frames: window.__catePerf!.frames(),
    longTasks: window.__catePerf!.longTasks(),
    longTasksSupported: window.__catePerf!.longTasksSupported(),
    counters: window.__catePerf!.renderCounts(),
    main: await window.electronAPI!.perfGetSnapshot(),
  }))
  await testInfo.attach('performance.json', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' })
})

// E2E windows deliberately remain unmapped. Exercise the production focus-event
// handlers without pretending a hidden window has real OS focus.
async function setMonitorFocus(focused: boolean): Promise<void> {
  await app.evaluate(({ app, BrowserWindow }, active) => {
    app.emit(active ? 'browser-window-focus' : 'browser-window-blur', {}, BrowserWindow.getAllWindows()[0])
  }, focused)
}

// -----------------------------------------------------------------------------
// Measurement harness
// -----------------------------------------------------------------------------

interface Measurement {
  label: string
  secs: number
  fps: number
  frames: { samples: number; meanMs: number; p95Ms: number; maxMs: number }
  longTasks: { count: number; maxMs: number }
  renders: Record<string, number>
  main: {
    totalCpu: number
    focused: boolean
    procs: Array<{ type: string; cpu: number; memMB: number }>
    terminal: { kbPerSec: number; chunksPerSec: number }
    spawnsPerSec: Record<string, number>
  } | null
}

/** Bracket a load action and capture renderer + main-process perf over it. */
async function measure(label: string, action: () => Promise<void>, settleMs = 400): Promise<Measurement> {
  const before = await page.evaluate(() => ({
    t: performance.now(),
    renders: window.__catePerf!.renderCounts(),
  }))
  await page.evaluate(() => window.__catePerf!.resetWindow())

  await action()
  await page.waitForTimeout(settleMs)

  const after = await page.evaluate(async () => ({
    t: performance.now(),
    renders: window.__catePerf!.renderCounts(),
    fps: window.__catePerf!.fps(),
    frames: window.__catePerf!.frames(),
    longTasks: window.__catePerf!.longTasks(),
    main: await window.electronAPI!.perfGetSnapshot(),
  }))

  const secs = Math.max(0.001, (after.t - before.t) / 1000)
  const perSec = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const k of Object.keys(b)) {
      const d = (b[k] ?? 0) - (a[k] ?? 0)
      if (d > 0) out[k] = Math.round(d / secs)
    }
    return out
  }

  return {
    label,
    secs: Math.round(secs * 10) / 10,
    fps: after.fps,
    frames: after.frames,
    longTasks: after.longTasks,
    renders: perSec(before.renders, after.renders),
    main: after.main
      ? {
          totalCpu: after.main.totalCpu,
          focused: after.main.focused,
          procs: after.main.procs.map((p) => ({ type: p.type, cpu: p.cpu, memMB: p.memMB })),
          terminal: after.main.terminal,
          spawnsPerSec: after.main.spawnsPerSec,
        }
      : null,
  }
}

function report(m: Measurement): void {
  const top = (r: Record<string, number>) =>
    Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}=${v}/s`).join('  ') || '(none)'
  const lines = [
    '',
    `──────── PERF: ${m.label}  (${m.secs}s window) ────────`,
    `  fps: ${m.fps}    longtasks: ${m.longTasks.count} (max ${Math.round(m.longTasks.maxMs)}ms)`,
    `  frame time: p95 ${m.frames.p95Ms.toFixed(1)}ms · max ${m.frames.maxMs.toFixed(1)}ms (${m.frames.samples} samples)`,
    `  renders/s:  ${top(m.renders)}`,
  ]
  if (m.main) {
    lines.push(`  Electron cpu: ${m.main.totalCpu}%   terminal: ${m.main.terminal.kbPerSec}KB/s (${m.main.terminal.chunksPerSec} chunks/s)`)
    lines.push(`  spawns/s:  ${Object.entries(m.main.spawnsPerSec).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`)
    lines.push(`  procs:  ${m.main.procs.slice(0, 4).map((p) => `${p.type} ${p.cpu}%/${p.memMB}MB`).join('  ')}`)
  }
  lines.push('────────────────────────────────────────────')
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'))
}

// -----------------------------------------------------------------------------
// Helpers to drive load over the canvas
// -----------------------------------------------------------------------------

/** A point on the canvas background known to be clear of seeded nodes. */
async function emptyCanvasPoint(): Promise<{ x: number; y: number }> {
  const box = await (await page.$('[data-canvas-container]'))!.boundingBox()
  if (!box) throw new Error('no canvas container')
  return { x: box.x + box.width * 0.85, y: box.y + box.height * 0.82 }
}

async function seedTerminals(count: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const col = i % 3
    const row = Math.floor(i / 3)
    const id = await page.evaluate(
      (p) => window.__cateE2E!.createTerminal(p),
      { x: 80 + col * 260, y: 80 + row * 220 },
    )
    ids.push(id)
    await page.waitForSelector(`[data-node-id="${id}"]`, { timeout: 5000 })
  }
  await page.waitForTimeout(400)
  return ids
}

// -----------------------------------------------------------------------------
// Scenarios
// -----------------------------------------------------------------------------

test('baseline: idle for 2s', async () => {
  const m = await measure('idle (2s)', async () => {
    await page.waitForTimeout(2000)
  }, 0)
  report(m)
  // Idle should be calm: no sustained long tasks.
  expect(m.longTasks.count).toBeLessThan(5)
})

test('profiler retains long tasks across HUD resets', async () => {
  await page.evaluate(() => {
    window.__catePerf!.resetWindow()
    return new Promise<void>((resolve) => setTimeout(() => {
      const until = performance.now() + 80
      while (performance.now() < until) { /* deliberate renderer task */ }
      resolve()
    }, 0))
  })
  await page.waitForTimeout(1200)
  const tasks = await page.evaluate(() => window.__catePerf!.longTasks())
  expect(tasks.count).toBeGreaterThan(0)
  expect(tasks.maxMs).toBeGreaterThanOrEqual(70)
})

test('canvas pan stress (wheel-pan over a populated canvas)', async () => {
  await seedTerminals(6)
  const pt = await emptyCanvasPoint()
  await page.mouse.move(pt.x, pt.y)

  const m = await measure('canvas pan (≈150 wheel events)', async () => {
    for (let i = 0; i < 150; i++) {
      const dx = (i % 20) - 10
      const dy = 6 + (i % 5)
      await page.mouse.wheel(dx, dy)
      if (i % 10 === 0) await page.waitForTimeout(8)
    }
  })
  report(m)
  // A populated canvas should still pan without freezing or collapsing to a slideshow.
  expect(m.fps).toBeGreaterThan(20)
  expect(m.longTasks.maxMs).toBeLessThan(2000)
})

test('canvas zoom stress (smooth-zoom re-render cascade)', async () => {
  // Ensure a populated canvas so the per-node re-render cost is visible.
  const nodeCount = await page.evaluate(() => window.__cateE2E!.nodes().length)
  if (nodeCount < 6) await seedTerminals(6 - nodeCount)

  await page.evaluate(() => { window.__cateE2E!.setZoom(1); window.__cateE2E!.resetViewport() })

  // Drive zoomLevel changes at rAF cadence from inside the page — deterministic
  // (no cursor/empty-space dependency) and faithful to the real smooth-zoom
  // path: each zoomLevel change flows CanvasPanel -> every CanvasNodeWrapper ->
  // every CanvasNode (zoomLevel is in its memo comparator), which is exactly
  // audit #4. A populated canvas re-renders every node on every zoom frame even
  // though node DOM positions are driven imperatively by the world transform.
  const m = await measure('canvas zoom (90 frames, populated)', async () => {
    await page.evaluate(async () => {
      const h = window.__cateE2E!
      const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)))
      for (let i = 0; i < 90; i++) {
        h.setZoom(1 + 0.4 * Math.sin(i / 7))
        await raf()
      }
    })
  })
  report(m)
  expect(m.fps).toBeGreaterThan(20)
  expect(m.longTasks.maxMs).toBeLessThan(2000)

  // Restore a neutral viewport.
  await page.evaluate(() => { window.__cateE2E!.setZoom(1); window.__cateE2E!.resetViewport() })
})

test('terminal flood (real shell blasting output)', async () => {
  const [nodeId] = await seedTerminals(1)
  // Wait for the PTY to spawn, then give the shell a beat to print its prompt
  // so the flood command isn't typed before the shell is reading input.
  await page.waitForFunction(
    (id) => !!window.__cateE2E!.terminalPtyId(id),
    nodeId,
    { timeout: 8000 },
  )
  await page.waitForTimeout(800)

  // Renderer-side deltas over the flood window.
  const before = await page.evaluate(() => ({
    t: performance.now(),
    renders: window.__catePerf!.renderCounts(),
  }))
  await page.evaluate(() => window.__catePerf!.resetWindow())

  // ~4M lines × ~21B sustains a multi-second flood (spans the 2s main sampler
  // window) yet still terminates. Exercises PTY -> disk-log -> IPC -> xterm
  // (audit #2: sync statSync+appendFileSync per 4KB on the data callback).
  await page.evaluate(
    (id) => window.__cateE2E!.writeTerminal(id, 'yes 0123456789ABCDEFGHIJ | head -n 4000000\n'),
    nodeId,
  )

  // Poll the main snapshot for PEAK throughput — robust to where the burst
  // falls relative to the sampler's 2s buckets.
  let peakKbPerSec = 0
  let peakChunksPerSec = 0
  let peakTotalCpu = 0
  let peakMainProcCpu = 0 // the 'Browser' process IS the main process in getAppMetrics
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(400)
    const snap = await page.evaluate(() => window.electronAPI!.perfGetSnapshot())
    if (snap) {
      peakKbPerSec = Math.max(peakKbPerSec, snap.terminal.kbPerSec)
      peakChunksPerSec = Math.max(peakChunksPerSec, snap.terminal.chunksPerSec)
      peakTotalCpu = Math.max(peakTotalCpu, snap.totalCpu)
      const main = snap.procs.find((p) => p.type === 'Browser')
      if (main) peakMainProcCpu = Math.max(peakMainProcCpu, main.cpu)
    }
  }

  const after = await page.evaluate(() => ({
    t: performance.now(),
    renders: window.__catePerf!.renderCounts(),
    fps: window.__catePerf!.fps(),
    frames: window.__catePerf!.frames(),
    longTasks: window.__catePerf!.longTasks(),
  }))

  // Best-effort: stop anything still running.
  await page.evaluate((id) => window.__cateE2E!.writeTerminal(id, '\x03'), nodeId)

  const secs = Math.max(0.001, (after.t - before.t) / 1000)
  const perSec = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const k of Object.keys(b)) {
      const d = (b[k] ?? 0) - (a[k] ?? 0)
      if (d > 0) out[k] = Math.round(d / secs)
    }
    return out
  }
  report({
    label: 'terminal flood (~4M lines, peak)',
    secs: Math.round(secs * 10) / 10,
    fps: after.fps,
    frames: after.frames,
    longTasks: after.longTasks,
    renders: perSec(before.renders, after.renders),
    main: {
      totalCpu: peakTotalCpu,
      focused: true,
      procs: [{ type: 'Browser(main)', cpu: peakMainProcCpu, memMB: 0 }],
      terminal: { kbPerSec: peakKbPerSec, chunksPerSec: peakChunksPerSec },
      spawnsPerSec: {},
    },
  })

  // The flood must have actually happened (proves the path was exercised) and
  // must not have frozen the main thread for seconds.
  expect(peakKbPerSec).toBeGreaterThan(0)
  expect(after.longTasks.maxMs).toBeLessThan(3000)
})

// -----------------------------------------------------------------------------
// "Real pain" scenarios: many terminals + big canvas. For terminals the cost is
// expected in the RENDERER (xterm/WebGL) and GPU, not the main process — so we
// capture peak per-process CPU (Browser=main, Tab=renderer, GPU) over a window.
// -----------------------------------------------------------------------------

async function mountedNodeCount(): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-node-id]').length)
}

/** Seed terminals (spread on a grid) until the canvas holds at least `total`. */
async function seedToTotal(total: number): Promise<void> {
  let have = await page.evaluate(() => window.__cateE2E!.nodes().length)
  while (have < total) {
    const i = have
    const col = i % 4
    const row = Math.floor(i / 4)
    const id = await page.evaluate(
      (p) => window.__cateE2E!.createTerminal(p),
      { x: 60 + col * 300, y: 60 + row * 240 },
    )
    await page.waitForSelector(`[data-node-id="${id}"]`, { timeout: 5000 })
    have++
  }
  await page.waitForTimeout(500)
  await setMonitorFocus(true)
}

interface PeakSample {
  fps: number
  frames: { samples: number; meanMs: number; p95Ms: number; maxMs: number }
  longTasks: { count: number; maxMs: number }
  renders: Record<string, number>
  perProcCpu: Record<string, number> // peak cpu per process type
  peakTerminalKbPerSec: number
  peakSpawnsTotal: number
  activityScansPerSec: number
  runtimeSamples: number
}

/** Run an action while polling the snapshot for peak per-process CPU. */
async function measurePeak(durationMs: number, action?: () => Promise<void>): Promise<PeakSample> {
  const before = await page.evaluate(() => ({
    renders: window.__catePerf!.renderCounts(),
  }))
  await page.evaluate(() => window.__catePerf!.resetWindow())

  const perProcCpu: Record<string, number> = {}
  let peakTerminalKbPerSec = 0
  let peakSpawnsTotal = 0
  let activityScans = 0
  let runtimeWindowSecs = 0
  let runtimeSamples = 0
  const sampleIds = new Set<number>()
  const startedAt = Date.now()
  const actionP = action ? action() : Promise.resolve()

  const polls = Math.max(1, Math.round(durationMs / 400))
  for (let i = 0; i < polls; i++) {
    await page.waitForTimeout(400)
    const snap = await page.evaluate(() => window.electronAPI!.perfGetSnapshot())
    if (!snap) continue
    const byType: Record<string, number> = {}
    for (const p of snap.procs) byType[p.type] = (byType[p.type] ?? 0) + p.cpu
    for (const [type, cpu] of Object.entries(byType)) perProcCpu[type] = Math.max(perProcCpu[type] ?? 0, cpu)
    if (snap.sampledAt && snap.sampledAt >= startedAt && !sampleIds.has(snap.sampledAt)) {
      sampleIds.add(snap.sampledAt)
      for (const runtime of snap.runtimes ?? []) {
        const sample = runtime.sample
        if (!sample || sample.windowMs <= 0) continue
        runtimeSamples++
        runtimeWindowSecs += sample.windowMs / 1000
        activityScans += (sample.monitorScansPerSec.activity ?? 0) * sample.windowMs / 1000
      }
    }
    peakTerminalKbPerSec = Math.max(peakTerminalKbPerSec, snap.terminal.kbPerSec)
    const spawns = Object.values(snap.spawnsPerSec).reduce((a, b) => a + b, 0)
    peakSpawnsTotal = Math.max(peakSpawnsTotal, spawns)
  }
  await actionP

  const after = await page.evaluate(() => ({
    renders: window.__catePerf!.renderCounts(),
    fps: window.__catePerf!.fps(),
    frames: window.__catePerf!.frames(),
    longTasks: window.__catePerf!.longTasks(),
  }))
  const secs = (Date.now() - startedAt) / 1000
  const perSec = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const k of Object.keys(b)) { const d = (b[k] ?? 0) - (a[k] ?? 0); if (d > 0) out[k] = Math.round(d / secs) }
    return out
  }
  return {
    fps: after.fps,
    frames: after.frames,
    longTasks: after.longTasks,
    renders: perSec(before.renders, after.renders),
    perProcCpu,
    peakTerminalKbPerSec,
    peakSpawnsTotal,
    activityScansPerSec: runtimeWindowSecs ? activityScans / runtimeWindowSecs : 0,
    runtimeSamples,
  }
}

function reportPeak(label: string, mounted: number, s: PeakSample): void {
  const top = (r: Record<string, number>) =>
    Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}=${v}/s`).join('  ') || '(none)'
  const procs = Object.entries(s.perProcCpu).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}%`).join('  ')
  // eslint-disable-next-line no-console
  console.log([
    '',
    `──────── PERF: ${label}  (${mounted} mounted nodes) ────────`,
    `  fps: ${s.fps}    longtasks: ${s.longTasks.count} (max ${Math.round(s.longTasks.maxMs)}ms)`,
    `  frame time: p95 ${s.frames.p95Ms.toFixed(1)}ms · max ${s.frames.maxMs.toFixed(1)}ms`,
    `  peak cpu by process:  ${procs}`,
    `  terminal: ${s.peakTerminalKbPerSec} KB/s    spawns: ${s.peakSpawnsTotal}/s`,
    `  renders/s:  ${top(s.renders)}`,
    '────────────────────────────────────────────',
  ].join('\n'))
}

test('many terminals (9) idle, all visible', async () => {
  await seedToTotal(9)
  await page.evaluate(() => { window.__cateE2E!.setZoom(0.5); window.__cateE2E!.resetViewport() })
  await page.waitForTimeout(600)
  const mounted = await mountedNodeCount()
  const s = await measurePeak(3000)
  reportPeak('9 terminals · idle', mounted, s)
  // Just-sitting-there should not peg a core or spin long tasks.
  expect(s.longTasks.count).toBeLessThan(8)
})

test('many terminals (9) with concurrent output in 4', async () => {
  await seedToTotal(9)
  await page.evaluate(() => { window.__cateE2E!.setZoom(0.5); window.__cateE2E!.resetViewport() })
  await page.waitForTimeout(400)
  const mounted = await mountedNodeCount()

  const ids = await page.evaluate(() => window.__cateE2E!.nodes().map((n) => n.id))
  // Wait for PTYs, then start a MODERATE sustained output in 4 terminals (a
  // realistic "builds running in several tabs", not a max flood).
  for (const id of ids.slice(0, 4)) {
    await page.waitForFunction((x) => !!window.__cateE2E!.terminalPtyId(x), id, { timeout: 8000 }).catch(() => {})
  }
  const s = await measurePeak(4000, async () => {
    for (const id of ids.slice(0, 4)) {
      await page.evaluate(
        (x) => window.__cateE2E!.writeTerminal(x, 'yes 0123456789ABCDEFGHIJKLMNOP | head -n 1500000\n'),
        id,
      )
    }
  })
  // Best-effort stop.
  for (const id of ids.slice(0, 4)) await page.evaluate((x) => window.__cateE2E!.writeTerminal(x, '\x03'), id)
  reportPeak('9 terminals · output in 4', mounted, s)
})

test('big canvas pan with 9 nodes visible', async () => {
  await seedToTotal(9)
  await page.evaluate(() => { window.__cateE2E!.setZoom(0.55); window.__cateE2E!.resetViewport() })
  await page.waitForTimeout(400)
  const mounted = await mountedNodeCount()
  const pt = await emptyCanvasPoint()
  await page.mouse.move(pt.x, pt.y)
  const s = await measurePeak(2600, async () => {
    for (let i = 0; i < 120; i++) {
      await page.mouse.wheel((i % 16) - 8, 5 + (i % 4))
      if (i % 10 === 0) await page.waitForTimeout(6)
    }
  })
  reportPeak('big canvas pan · 9 nodes', mounted, s)
  expect(s.fps).toBeGreaterThan(20)
  expect(s.longTasks.maxMs).toBeLessThan(2000)
})

// =============================================================================
// Battery scenarios — the cost the app pays just for being open. These guard
// the "lightweight, not battery-draining" goal: idle/background CPU is the
// number a laptop user actually feels. The dominant lever is subprocess spawns
// (pgrep/ps/lsof) from the terminal process-monitor, so these assert on the
// spawn rate the main profiler counts.
// =============================================================================

test('idle spawn budget — 9 terminals, focused monitor cadence', async () => {
  await seedToTotal(9)
  await page.evaluate(() => { window.__cateE2E!.setZoom(0.5); window.__cateE2E!.resetViewport() })
  await page.waitForTimeout(800)
  const mounted = await mountedNodeCount()
  // Sit idle and watch what the monitor spawns. With the 1s activity scan +
  // 5s lsof scan, the steady state for plain shells is a handful of pgrep/ps
  // per terminal per second; nothing should runaway.
  await setMonitorFocus(true)
  await page.waitForTimeout(2200)
  const s = await measurePeak(4000)
  reportPeak('9 terminals · idle spawn budget', mounted, s)
  // With the batched single-`ps`-snapshot scan, idle steady state is ~1 ps/s
  // (activity) plus the 5s lsof cycle (ports + per-terminal cwd). The peak in
  // any 2s sampler window is well under 15; the old per-PID fan-out sat at
  // ~18/s for 9 terminals, so this ceiling guards against regressing to it.
  expect(s.runtimeSamples).toBeGreaterThan(0)
  expect(s.activityScansPerSec).toBeGreaterThan(0)
  expect(s.peakSpawnsTotal).toBeLessThan(15)
})

test('background monitor cadence backs off on simulated focus events', async () => {
  await seedToTotal(9)
  await page.evaluate(() => { window.__cateE2E!.setZoom(0.5); window.__cateE2E!.resetViewport() })
  await page.waitForTimeout(800)
  const mounted = await mountedNodeCount()

  // Exercise the focused cadence through the production application event.
  await setMonitorFocus(true)
  await page.waitForTimeout(2200)
  const focused = await measurePeak(4000)

  // The windowless harness cannot change native OS focus; use its application
  // event boundary and measure actual daemon scan work at the resulting cadence.
  await setMonitorFocus(false)
  // Let the focused-cadence timer that was already armed drain, then sample the
  // backed-off cadence (activity 1s→5s, lsof 5s→15s).
  await page.waitForTimeout(2500)
  const unfocused = await measurePeak(6000)

  // Restore the focused monitor cadence for later scenarios.
  await setMonitorFocus(true)

  // eslint-disable-next-line no-console
  console.log(`\n──────── PERF: background battery (${mounted} terminals) ────────`)
  // eslint-disable-next-line no-console
  console.log(`  focused activity scans: ${focused.activityScansPerSec.toFixed(2)}/s    unfocused: ${unfocused.activityScansPerSec.toFixed(2)}/s`)
  // eslint-disable-next-line no-console
  console.log('────────────────────────────────────────────')

  // The focused baseline must have actually been scanning (proves the path is
  // live and the assertion is meaningful)…
  expect(focused.runtimeSamples).toBeGreaterThan(0)
  expect(unfocused.runtimeSamples).toBeGreaterThan(0)
  expect(focused.activityScansPerSec).toBeGreaterThan(0)
  // …and backgrounding must cut the scan rate. The 5× cadence back-off means
  // unfocused should sit well below focused; assert a conservative ≤60%.
  expect(unfocused.activityScansPerSec).toBeLessThan(focused.activityScansPerSec * 0.6)
})

// =============================================================================
// Editor typing — there was no Monaco perf coverage. Typing should never block
// the main thread: every keystroke runs Monaco's tokenizer + a debounced store
// write, and a long task here is felt directly as input lag.
// =============================================================================

test('editor typing stays smooth (no long tasks)', async () => {
  const nodeId = await page.evaluate(() => window.__cateE2E!.createEditor({ x: 120, y: 120 }))
  await page.waitForSelector(`[data-node-id="${nodeId}"]`, { timeout: 5000 })
  // Monaco mounts asynchronously — wait for its input textarea before typing.
  const textarea = await page.waitForSelector(
    `[data-node-id="${nodeId}"] .monaco-editor textarea`,
    { timeout: 10_000 },
  )
  // Focus the Monaco input directly — a .click() lands on Monaco's own overlay
  // (.view-lines / data-mode-id div), which intercepts the pointer event and
  // never reaches the hidden textarea. Focusing the textarea makes it the
  // activeElement so page.keyboard.type() is delivered to the editor.
  await textarea.evaluate((el) => (el as HTMLTextAreaElement).focus())
  await page.waitForTimeout(200)

  const m = await measure('editor typing (~280 chars)', async () => {
    await page.keyboard.type(
      'The quick brown fox jumps over the lazy dog. '.repeat(6),
      { delay: 8 },
    )
  })
  report(m)
  // Typing must not stall the main thread. A keystroke that blocks for ~½s
  // would be a visible freeze; the steady state is sub-frame.
  expect(m.longTasks.maxMs).toBeLessThan(500)
})

// =============================================================================
// Viewport-cull cost — useVisibleNodeIds runs on EVERY store update, including
// every pan/zoom frame (only the viewport changed, nodes are unchanged). The
// expensive part is Object.values(nodes).sort(); it's memoized by nodes-object
// identity, so a pure pan must hit the cache, not re-sort 60×/s. Instrumented
// via perfCount: canvasCullEval (every selector run) vs canvasCullSort (the
// real sort). This locks in the memoization fix.
// =============================================================================

test('cull selector reuses the cached node sort across viewport changes', async () => {
  await seedToTotal(9)
  await page.evaluate(() => { window.__cateE2E!.setZoom(1); window.__cateE2E!.resetViewport() })
  await page.waitForTimeout(300)

  // Drive zoomLevel at rAF cadence from inside the page — deterministic (no
  // mouse hit-testing, which gets flaky once nodes accumulate across tests) and
  // faithful: zoomLevel is one of useVisibleNodeIds' inputs, so every frame
  // re-runs the cull selector. The node SET is unchanged across the sweep, so
  // the WeakMap sort-cache must serve every eval — this is the memoization fix.
  const m = await measure('cull eval under viewport sweep (90 frames)', async () => {
    await page.evaluate(async () => {
      const h = window.__cateE2E!
      const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)))
      for (let i = 0; i < 90; i++) {
        h.setZoom(1 + 0.4 * Math.sin(i / 7))
        await raf()
      }
    })
  })
  report(m)
  await page.evaluate(() => { window.__cateE2E!.setZoom(1); window.__cateE2E!.resetViewport() })

  const evals = m.renders['canvasCullEval'] ?? 0
  const sorts = m.renders['canvasCullSort'] ?? 0
  // eslint-disable-next-line no-console
  console.log(`  cull: ${evals} evals/s, ${sorts} sorts/s`)
  // The sweep must drive the cull selector (zoomLevel changes each frame)…
  expect(evals).toBeGreaterThan(10)
  // …but the node set is unchanged, so the sort cache should serve nearly every
  // eval. A per-frame re-sort would push this up toward `evals`.
  expect(sorts).toBeLessThanOrEqual(3)
})

for (const total of [10, 25]) {
  test(`browser surface geometry with ${total} overlapping panels`, async () => {
    const have = await page.locator('[data-browser-surface-slot]').count()
    for (let index = have; index < total; index++) {
      await page.evaluate((i) => window.__cateE2E!.createBrowser('about:blank', { x: 20 + (i % 5) * 60, y: 20 + Math.floor(i / 5) * 50 }), index)
    }
    await expect(page.locator('[data-browser-surface-slot]')).toHaveCount(total)
    // Creation avoids overlap; move the cards explicitly to exercise occlusion.
    await page.evaluate(() => {
      const browserIds = new Set([...document.querySelectorAll<HTMLElement>('[data-browser-surface-slot]')].map((slot) => slot.dataset.browserSurfaceSlot))
      window.__cateE2E!.nodes().filter((node) => browserIds.has(node.panelId)).forEach((node, index) => {
        window.__cateE2E!.moveNode(node.id, { x: 20 + (index % 5) * 60, y: 20 + Math.floor(index / 5) * 50 })
      })
    })
    await page.evaluate(() => { window.__cateE2E!.setZoom(0.4); window.__cateE2E!.resetViewport() })
    await page.waitForTimeout(1000)
    await expect(page.locator('[data-browser-surface-visible="true"]')).toHaveCount(total)
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-browser-surface-slot]')]
      .filter((slot) => window.__cateE2E!.browserWebContentsId(slot.dataset.browserSurfaceSlot!) !== null).length), { timeout: 20_000 }).toBe(total)
    const m = await measure(`${total} browser surfaces · zoom`, async () => {
      await page.evaluate(async () => {
        for (let frame = 0; frame < 90; frame++) {
          window.__cateE2E!.setZoom(0.4 + 0.05 * Math.sin(frame / 12))
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
      })
    })
    report(m)
    expect(m.renders.browserGeometryFrame).toBeGreaterThan(10)
    expect(m.fps).toBeGreaterThan(20)
    expect(m.longTasks.maxMs).toBeLessThan(1000)
  })
}
