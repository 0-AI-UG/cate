// E2E fixture: launch the built Electron app with an isolated userData dir.
//
// Each spec calls `launchApp()` in beforeEach. CATE_E2E=1 causes:
//   - main process to point app.setPath('userData', tmpdir)
//   - renderer to install window.__cateE2E (see src/renderer/lib/e2eHarness.ts)

import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import path from 'node:path'

export interface LaunchResult {
  electronApp: ElectronApplication
  mainWindow: Page
}

const REPO_ROOT = path.resolve(__dirname, '..', '..')

export async function launchApp(opts: { perf?: boolean } = {}): Promise<LaunchResult> {
  const electronApp = await electron.launch({
    args: ['.'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CATE_E2E: '1',
      NODE_ENV: 'production',
      // Activate the resource profiler (main getAppMetrics sampler + counters,
      // renderer FPS/long-task/render counters, window.__catePerf) for the
      // perf-stress spec. Harmless no-op for other specs that don't set it.
      ...(opts.perf ? { CATE_PERF: '1' } : {}),
    },
  })
  const mainWindow = await electronApp.firstWindow()
  await mainWindow.waitForLoadState('domcontentloaded')
  await mainWindow.waitForFunction(() => window.__cateE2E?.ready === true, { timeout: 15_000 })
  return { electronApp, mainWindow }
}

export async function closeApp(electronApp: ElectronApplication): Promise<void> {
  try {
    await electronApp.close()
  } catch {
    /* best-effort */
  }
}

// -----------------------------------------------------------------------------
// Drag helpers
// -----------------------------------------------------------------------------

export async function dragMouse(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { steps?: number; holdDownMs?: number; pauseAtEnd?: number } = {},
): Promise<void> {
  const steps = opts.steps ?? 20
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  if (opts.holdDownMs) await page.waitForTimeout(opts.holdDownMs)
  await page.mouse.move(to.x, to.y, { steps })
  if (opts.pauseAtEnd) await page.waitForTimeout(opts.pauseAtEnd)
  await page.mouse.up()
}

export async function getNodeRect(
  page: Page,
  nodeId: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const handle = await page.$(`[data-node-id="${nodeId}"]`)
  if (!handle) return null
  return handle.boundingBox()
}

export async function getNodeOrigin(
  page: Page,
  nodeId: string,
): Promise<{ x: number; y: number } | null> {
  return page.evaluate((id) => {
    const n = window.__cateE2E?.nodes().find((x) => x.id === id)
    return n ? n.origin : null
  }, nodeId)
}

export async function seedTerminal(
  page: Page,
  point: { x: number; y: number } = { x: 200, y: 200 },
): Promise<string> {
  const id = await page.evaluate((p) => window.__cateE2E!.createTerminal(p), point)
  // Wait for the entering animation to settle so opacity/transform are at
  // their final values before tests interact with the node.
  await page.waitForSelector(`[data-node-id="${id}"]`)
  await page.waitForTimeout(400)
  return id
}

export async function seedCanvasPanel(
  page: Page,
  point: { x: number; y: number } = { x: 200, y: 200 },
): Promise<string> {
  return page.evaluate((p) => window.__cateE2E!.createCanvasPanel(p), point)
}

export async function setZoom(page: Page, zoom: number): Promise<void> {
  await page.evaluate((z) => window.__cateE2E!.setZoom(z), zoom)
  await page.waitForTimeout(80)
}

export async function resetViewport(page: Page): Promise<void> {
  await page.evaluate(() => window.__cateE2E!.resetViewport())
  await page.waitForTimeout(30)
}

export async function dragSnapshot(page: Page) {
  return page.evaluate(() => window.__cateE2E!.dragSnapshot())
}

export async function titleBarCentre(
  page: Page,
  nodeId: string,
): Promise<{ x: number; y: number } | null> {
  const rect = await getNodeRect(page, nodeId)
  if (!rect) return null
  // Aim INSIDE the first tab (the tab handler routes to dock-tab drag, which
  // resolveDrop maps to canvas-reposition for same-canvas drops). The empty
  // tab-bar spacer absorbs mousedown without dispatching to the host's
  // onTabBarMouseDown, so we deliberately target a real tab element.
  return { x: rect.x + 40, y: rect.y + 6 }
}

export async function waitForGhost(
  page: Page,
  timeout = 2000,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    const handle = await page.waitForSelector('[data-drag-overlay-ghost="true"]', {
      state: 'attached',
      timeout,
    })
    return handle.boundingBox()
  } catch {
    return null
  }
}

/** Pick the first canvas-node currently in the DOM. */
export async function firstNodeInfo(page: Page): Promise<{
  nodeId: string
  rect: { x: number; y: number; width: number; height: number }
  grab: { x: number; y: number }
} | null> {
  const handle = await page.$('[data-node-id]')
  if (!handle) return null
  const nodeId = (await handle.getAttribute('data-node-id')) ?? ''
  const rect = await handle.boundingBox()
  if (!rect) return null
  return {
    nodeId,
    rect,
    grab: { x: rect.x + rect.width / 2, y: rect.y + 14 },
  }
}
