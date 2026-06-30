// =============================================================================
// Worktree-terrace performance stress test — drives the WebGL "territory" layer
// (and its screen-space scissor) under load and measures the cost.
//
// The terrace is a full-screen fragment-shader field (domain-warp + per-panel
// SDF loop + per-worktree colour blend) that redraws on every pan / zoom / drag
// frame while worktrees are present. These scenarios make it render (2+ live
// worktrees, panels tagged into them) and then bracket pan / zoom / drag with
// the shared perf harness, reporting:
//   - renderer FPS + long tasks (>50ms main-thread blocks = visible jank)
//   - peak per-process CPU (GPU = the shader cost; Tab = renderer)
//   - territory draws/sec and the scissor's shaded-vs-full-canvas area ratio
//     (territoryDraw / territoryScissorKpx / territoryFullKpx, instrumented in
//     territoryGL.draw under CATE_PERF=1)
//
// Thresholds are deliberately GENEROUS — they only catch egregious regressions
// (sub-20fps drags, multi-second freezes, the terrace silently not rendering).
// The printed report is the point: it gives before/after numbers for the GL
// shader cost and proves the scissor clips empty regions.
//
// GL is the primary path; if WebGL2 / fragment-highp is unavailable the layer
// falls back to CPU and the GL-only scissor assertions are skipped (reported).
//
// Run:  npm run build && npx playwright test e2e/worktree-territory-perf.spec.ts
// =============================================================================

import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './fixtures/electron-app'
import type { ElectronApplication, Page } from 'playwright'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp({ perf: true }))
  await page.waitForFunction(() => typeof window.__catePerf === 'object', { timeout: 15_000 })
})

test.afterAll(async () => closeApp(app))

// Each scenario seeds its own world; clear the canvas first so node counts and
// layout don't accumulate across tests (the app instance is shared via beforeAll).
test.beforeEach(async () => {
  await page.evaluate(() => { window.__cateE2E!.clearCanvas(); window.__cateE2E!.setZoom(1); window.__cateE2E!.resetViewport() })
  await page.waitForTimeout(150)
})

// -----------------------------------------------------------------------------
// Measurement harness (terrace-focused: adds territory draw/scissor counters and
// peak GPU/renderer CPU to the FPS + long-task signals).
// -----------------------------------------------------------------------------

interface TerritoryMeasurement {
  label: string
  secs: number
  fps: number
  longTasks: { count: number; maxMs: number }
  /** territoryGL.draw calls over the window. */
  draws: number
  drawsPerSec: number
  /** Mean shaded-area fraction (scissor rect ÷ full canvas) across drawn frames;
   *  null when nothing drew (CPU fallback / no coverage). 1 = no clipping. */
  scissorRatio: number | null
  perProcCpu: Record<string, number>
  /** Panels actually feeding the terrace (tagged + mounted). The shader's
   *  per-fragment primitive loop is O(this), NOT O(total seeded) — off-screen
   *  nodes are culled out, so this is the real shader load. */
  livePanels: number
  /** Mounted canvas nodes (DOM) — what the viewport cull left on screen. */
  mountedNodes: number
}

async function measureTerritory(
  label: string,
  durationMs: number,
  action: () => Promise<void>,
): Promise<TerritoryMeasurement> {
  const before = await page.evaluate(() => ({
    t: performance.now(),
    rc: window.__catePerf!.renderCounts(),
  }))
  await page.evaluate(() => window.__catePerf!.resetWindow())

  const perProcCpu: Record<string, number> = {}
  const actionP = action()
  const polls = Math.max(1, Math.round(durationMs / 400))
  for (let i = 0; i < polls; i++) {
    await page.waitForTimeout(400)
    const snap = await page.evaluate(() => window.electronAPI!.perfGetSnapshot())
    if (snap) for (const p of snap.procs) perProcCpu[p.type] = Math.max(perProcCpu[p.type] ?? 0, p.cpu)
  }
  await actionP

  const after = await page.evaluate(() => ({
    t: performance.now(),
    rc: window.__catePerf!.renderCounts(),
    fps: window.__catePerf!.fps(),
    longTasks: window.__catePerf!.longTasks(),
    livePanels: window.__cateE2E!.worktreeDebug().taggedNodes,
    mountedNodes: document.querySelectorAll('[data-node-id]').length,
  }))

  const secs = Math.max(0.001, (after.t - before.t) / 1000)
  const d = (k: string) => (after.rc[k] ?? 0) - (before.rc[k] ?? 0)
  const draws = d('territoryDraw')
  const scissorKpx = d('territoryScissorKpx')
  const fullKpx = d('territoryFullKpx')
  return {
    label,
    secs: Math.round(secs * 10) / 10,
    fps: after.fps,
    longTasks: after.longTasks,
    draws,
    drawsPerSec: Math.round(draws / secs),
    scissorRatio: fullKpx > 0 ? Math.round((scissorKpx / fullKpx) * 100) / 100 : null,
    perProcCpu,
    livePanels: after.livePanels,
    mountedNodes: after.mountedNodes,
  }
}

function report(m: TerritoryMeasurement): void {
  const procs = Object.entries(m.perProcCpu).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}%`).join('  ')
  const ratio = m.scissorRatio == null ? 'n/a (no GL draws)' : `${Math.round(m.scissorRatio * 100)}% of canvas`
  // eslint-disable-next-line no-console
  console.log([
    '',
    `──────── TERRACE PERF: ${m.label}  (${m.secs}s window) ────────`,
    `  live panels in terrace: ${m.livePanels}    mounted nodes: ${m.mountedNodes}`,
    `  fps: ${m.fps}    longtasks: ${m.longTasks.count} (max ${Math.round(m.longTasks.maxMs)}ms)`,
    `  territory draws: ${m.draws} (${m.drawsPerSec}/s)    scissor shaded: ${ratio}`,
    `  peak cpu by process:  ${procs || '(none)'}`,
    '────────────────────────────────────────────',
  ].join('\n'))
}

// -----------------------------------------------------------------------------
// Seeding: a worktree "world" — terminals laid on a grid, split across N
// worktrees, with the terrace engaged.
// -----------------------------------------------------------------------------

const COLORS = ['#e5484d', '#30a46c', '#0091ff', '#f5a623', '#8e4ec6']

// Stress load: overflow the viewport so the cluster spans more than fits, then
// zoom out to mount as many as the (small, windowless) e2e viewport allows. The
// terrace shader only pays for VISIBLE panels — off-screen nodes are culled out
// of membership — so this caps at whatever the viewport mounts (~10 here), and
// piling on more seeded panels only adds PTY-spawn cost, not shader load.
const LOAD = 20
const GROUPS = 4

/** Seed `count` terminals on a grid (tight `spread:false` cluster, or spread far
 *  apart), split round-robin across `groups` worktrees with the terrace on. */
async function seedWorktreeWorld(
  count: number,
  groups: number,
  spread: boolean,
): Promise<void> {
  const step = spread ? { x: 900, y: 760 } : { x: 200, y: 170 }
  const cols = spread ? 3 : 4
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const id = await page.evaluate(
      (p) => window.__cateE2E!.createTerminal(p),
      { x: 60 + col * step.x, y: 60 + row * step.y },
    )
    ids.push(id)
    await page.waitForSelector(`[data-node-id="${id}"]`, { timeout: 5000 })
  }

  const worktrees = await page.evaluate(
    (specs) => window.__cateE2E!.seedWorktrees(specs),
    Array.from({ length: groups }, (_, i) => ({ color: COLORS[i % COLORS.length], label: `wt-${i}` })),
  )
  // Tag each terminal into a worktree round-robin (index 0 = primary).
  for (let i = 0; i < ids.length; i++) {
    await page.evaluate(
      ({ nodeId, wtId }) => window.__cateE2E!.tagNodeWorktree(nodeId, wtId),
      { nodeId: ids[i], wtId: worktrees[i % worktrees.length].id },
    )
  }
  // Wait for CanvasNode to publish the tags so membership forms 2+ groups.
  await page.waitForFunction(
    () => window.__cateE2E!.worktreeDebug().distinctGroups >= 2,
    undefined,
    { timeout: 5000 },
  )
  await page.waitForTimeout(300)
}

/** Clear seeded nodes between scenarios so counts/layout don't accumulate. */
async function resetWorld(): Promise<void> {
  await page.evaluate(() => {
    const h = window.__cateE2E!
    h.setZoom(1)
    h.resetViewport()
  })
}

/** Zoom out + settle so the whole seeded cluster clears the viewport cull and
 *  mounts — otherwise off-screen panels are culled and never reach the shader,
 *  so the terrace would only ever render the few panels visible at zoom 1. */
async function zoomOut(zoom = 0.4): Promise<void> {
  await page.evaluate((z) => { window.__cateE2E!.setZoom(z); window.__cateE2E!.resetViewport() }, zoom)
  await page.waitForTimeout(500)
}

// -----------------------------------------------------------------------------
// Scenarios
// -----------------------------------------------------------------------------

test('terrace engages (sanity: 2+ worktrees, many panels feed the shader)', async () => {
  await seedWorktreeWorld(LOAD, GROUPS, false)
  await zoomOut()
  const dbg = await page.evaluate(() => window.__cateE2E!.worktreeDebug())
  // eslint-disable-next-line no-console
  console.log(`\n  worktree debug: ${JSON.stringify(dbg)}`)
  expect(dbg.liveWorktrees).toBeGreaterThanOrEqual(2)
  expect(dbg.distinctGroups).toBeGreaterThanOrEqual(2)
  // The territory canvas must be mounted (GL or CPU backend).
  const hasCanvas = await page.evaluate(
    () => !!document.querySelector('[data-worktree-territory], [data-worktree-territory-cpu]'),
  )
  expect(hasCanvas).toBe(true)
})

test('terrace pan stress (rAF-driven viewport sweep — redraw every frame)', async () => {
  await seedWorktreeWorld(LOAD, GROUPS, false)
  await zoomOut()

  // Drive the viewport offset at rAF cadence from inside the page. Each change
  // flows canvasStore → the territory layer's onChange → paintGL → draw, so the
  // shader redraws every pan frame (pan is just a uniform update + one quad).
  // Programmatic (not wheel) so it's deterministic and faithful even in the
  // windowless e2e harness, which doesn't reliably route wheel-pan to the canvas.
  const m = await measureTerritory('terrace pan (90 frames)', 2000, async () => {
    await page.evaluate(async () => {
      const h = window.__cateE2E!
      const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)))
      for (let i = 0; i < 90; i++) {
        h.setViewport({ x: Math.round(220 * Math.sin(i / 6)), y: Math.round(160 * Math.cos(i / 9)) })
        await raf()
      }
    })
  })
  report(m)
  await resetWorld()
  // The terrace must actually be loaded (panels visible), stay interactive, and
  // keep the shader running.
  expect(m.livePanels).toBeGreaterThanOrEqual(5)
  expect(m.fps).toBeGreaterThan(20)
  expect(m.longTasks.maxMs).toBeLessThan(2000)
  if (m.draws > 0) expect(m.scissorRatio).not.toBeNull()
})

test('terrace zoom stress (rAF-driven zoom sweep — setView every frame)', async () => {
  await seedWorktreeWorld(LOAD, GROUPS, false)
  await zoomOut()

  // Drive zoomLevel at rAF cadence from inside the page: each change flows
  // through canvasStore → the territory layer's onChange → paintGL → draw, so
  // the shader redraws every frame (the full pan/zoom-is-just-a-uniform path).
  // Sweep in a zoomed-out band (0.2–0.6) so the seeded panels stay mounted and
  // keep feeding the shader instead of being culled at zoom 1.
  const m = await measureTerritory('terrace zoom (90 frames)', 2000, async () => {
    await page.evaluate(async () => {
      const h = window.__cateE2E!
      const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)))
      for (let i = 0; i < 90; i++) {
        h.setZoom(0.4 + 0.2 * Math.sin(i / 7))
        await raf()
      }
    })
  })
  report(m)
  await resetWorld()
  expect(m.livePanels).toBeGreaterThanOrEqual(5)
  expect(m.fps).toBeGreaterThan(20)
  expect(m.longTasks.maxMs).toBeLessThan(2000)
})

test('terrace node-move stress (per-frame geometry rebuild + GL re-upload + redraw)', async () => {
  await seedWorktreeWorld(LOAD, GROUPS, false)
  await zoomOut()
  const nodeId = await page.evaluate(() => window.__cateE2E!.nodes()[0]?.id)
  const start = await page.evaluate((id) => window.__cateE2E!.nodes().find((n) => n.id === id)?.origin, nodeId)
  if (!nodeId || !start) throw new Error('no seeded node')

  // Moving a node's origin every frame is the hottest terrace path: the content
  // signature changes each frame, so the layer rebuilds groups, re-uploads the
  // primitive geometry texture, AND redraws — exactly what a live node-drag costs
  // (minus the synthetic mouse, which the hidden e2e window doesn't route to the
  // node). Drives the node in a circle at rAF cadence.
  const m = await measureTerritory('terrace node-move (90 frames, circular)', 2000, async () => {
    await page.evaluate(async ({ id, sx, sy }) => {
      const h = window.__cateE2E!
      const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)))
      for (let i = 0; i < 90; i++) {
        const a = (i / 90) * Math.PI * 2
        h.moveNode(id, { x: sx + Math.cos(a) * 160, y: sy + Math.sin(a) * 130 })
        await raf()
      }
      h.moveNode(id, { x: sx, y: sy }) // restore
    }, { id: nodeId, sx: start.x, sy: start.y })
  })
  report(m)
  expect(m.livePanels).toBeGreaterThanOrEqual(5)
  expect(m.fps).toBeGreaterThan(20)
  expect(m.longTasks.maxMs).toBeLessThan(2500)
  if (m.draws > 0) expect(m.scissorRatio).not.toBeNull()
})

test('scissor clips empty regions (a tiny cluster shades far less than a full-viewport one)', async () => {
  await seedWorktreeWorld(6, 2, false)
  await resetWorld()

  // A small programmatic viewport jiggle that forces a handful of GL draws at a
  // fixed zoom (each setViewport → onChange → paintGL → draw).
  const jiggle = async () => {
    await page.evaluate(async () => {
      const h = window.__cateE2E!
      const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)))
      for (let i = 0; i < 24; i++) { h.setViewport({ x: (i % 6) - 3, y: (i % 4) - 2 }); await raf() }
    })
  }

  // Zoomed IN so the cluster's terrace spans the viewport → scissor ≈ full.
  const zoomedIn = await measureTerritory('scissor · cluster fills viewport (zoom 1.6)', 1200, async () => {
    await page.evaluate(() => { window.__cateE2E!.setZoom(1.6); window.__cateE2E!.resetViewport() })
    await jiggle()
  })
  report(zoomedIn)

  // Zoomed OUT so the same cluster is a small island → scissor clips the empty
  // surround and shades far fewer pixels.
  const zoomedOut = await measureTerritory('scissor · cluster is a small island (zoom 0.3)', 1200, async () => {
    await page.evaluate(() => { window.__cateE2E!.setZoom(0.3); window.__cateE2E!.resetViewport() })
    await jiggle()
  })
  report(zoomedOut)
  await resetWorld()

  // Only assert the scissor win when the GL backend actually drew (CPU fallback
  // doesn't scissor and reports no ratio).
  if (zoomedIn.scissorRatio != null && zoomedOut.scissorRatio != null) {
    // eslint-disable-next-line no-console
    console.log(`\n  scissor shaded-area: zoomed-in ${Math.round(zoomedIn.scissorRatio * 100)}%  vs  zoomed-out ${Math.round(zoomedOut.scissorRatio * 100)}%`)
    // The small island must shade a strictly smaller fraction of the canvas than
    // the viewport-filling one — that gap IS the fragment work the scissor saved.
    expect(zoomedOut.scissorRatio).toBeLessThan(zoomedIn.scissorRatio)
  } else {
    // eslint-disable-next-line no-console
    console.log('\n  (CPU territory backend — GL scissor assertion skipped)')
    test.skip(true, 'GL territory backend unavailable in this environment')
  }
})
