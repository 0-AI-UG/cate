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
})

test.afterAll(async () => closeApp(app))

// -----------------------------------------------------------------------------
// Measurement harness
// -----------------------------------------------------------------------------

interface Measurement {
  label: string
  secs: number
  fps: number
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
    `  renders/s:  ${top(m.renders)}`,
  ]
  if (m.main) {
    lines.push(`  main cpu: ${m.main.totalCpu}%   terminal: ${m.main.terminal.kbPerSec}KB/s (${m.main.terminal.chunksPerSec} chunks/s)`)
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
}

interface PeakSample {
  fps: number
  longTasks: { count: number; maxMs: number }
  renders: Record<string, number>
  perProcCpu: Record<string, number> // peak cpu per process type
  peakTerminalKbPerSec: number
  peakSpawnsTotal: number
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
  const actionP = action ? action() : Promise.resolve()

  const polls = Math.max(1, Math.round(durationMs / 400))
  for (let i = 0; i < polls; i++) {
    await page.waitForTimeout(400)
    const snap = await page.evaluate(() => window.electronAPI!.perfGetSnapshot())
    if (!snap) continue
    for (const p of snap.procs) perProcCpu[p.type] = Math.max(perProcCpu[p.type] ?? 0, p.cpu)
    peakTerminalKbPerSec = Math.max(peakTerminalKbPerSec, snap.terminal.kbPerSec)
    const spawns = Object.values(snap.spawnsPerSec).reduce((a, b) => a + b, 0)
    peakSpawnsTotal = Math.max(peakSpawnsTotal, spawns)
  }
  await actionP

  const after = await page.evaluate(() => ({
    renders: window.__catePerf!.renderCounts(),
    fps: window.__catePerf!.fps(),
    longTasks: window.__catePerf!.longTasks(),
  }))
  const secs = durationMs / 1000
  const perSec = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const k of Object.keys(b)) { const d = (b[k] ?? 0) - (a[k] ?? 0); if (d > 0) out[k] = Math.round(d / secs) }
    return out
  }
  return {
    fps: after.fps,
    longTasks: after.longTasks,
    renders: perSec(before.renders, after.renders),
    perProcCpu,
    peakTerminalKbPerSec,
    peakSpawnsTotal,
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
