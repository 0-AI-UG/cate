// Multi-canvas regressions — several canvas tabs in the center dock zone.
//
// Bug 1 (remount): DockTabStack rendered the active tab's content without a
// React key, so switching between two canvas tabs REUSED the same mounted
// Canvas instance with a swapped panelId prop. Canvas wires its world-transform
// subscription, wheel handling, and observers in mount-only effects, so the
// visible canvas kept rendering/zooming through the PREVIOUS canvas's store:
// zoom appeared dead, panels created on the hidden store never appeared, and
// the world transform showed another canvas's viewport.
//
// Bug 2 (placement routing): an unpinned panel create (keyboard shortcut,
// programmatic create) routed to the workspace's PRIMARY canvas (first canvas
// tab) instead of the ACTIVE one, so with a secondary canvas tab active the new
// panel landed on a hidden canvas.
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './fixtures/electron-app'
import type { ElectronApplication, Page } from 'playwright'

let app: ElectronApplication
let page: Page

const EXTRA_CANVASES = 6

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  await page.evaluate(() => window.__cateE2E!.setSidebarHidden(true))
  // Seed: 6 extra canvas tabs beside the default one. Each create activates
  // the new tab, so the LAST canvas ends up active/mounted.
  for (let i = 0; i < EXTRA_CANVASES; i++) {
    await page.evaluate(() => void window.__cateE2E!.createCanvasPanel({ x: 100, y: 100 }))
  }
  await page.waitForTimeout(200)
})
test.afterEach(async () => closeApp(app))

/** The single mounted canvas: its panel id, its world div's CSS transform, and
 *  its store zoom (the harness resolves the store by the mounted DOM id). */
function mountedCanvas(p: Page) {
  return p.evaluate(() => {
    const el = document.querySelector('[data-canvas-panel-id]') as HTMLElement | null
    const world = el?.querySelector('div[style*="transform-origin"]') as HTMLElement | null
    return {
      id: el?.getAttribute('data-canvas-panel-id') ?? null,
      transform: world?.style.transform ?? null,
      zoom: window.__cateE2E!.zoom(),
    }
  })
}

/** Ids of all canvas tabs in the center tab strip, in order. */
function canvasTabIds(p: Page) {
  return p.evaluate(() =>
    Array.from(document.querySelectorAll('.dock-tab-bar [data-tab-panel-id]')).map(
      (el) => el.getAttribute('data-tab-panel-id')!,
    ),
  )
}

test('exactly one canvas is mounted and it is the last-created tab', async () => {
  const tabs = await canvasTabIds(page)
  expect(tabs.length).toBe(EXTRA_CANVASES + 1)

  const mountedIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-canvas-panel-id]')).map((el) =>
      el.getAttribute('data-canvas-panel-id'),
    ),
  )
  expect(mountedIds).toEqual([tabs[tabs.length - 1]])
})

test('unpinned create lands on the ACTIVE canvas, not the hidden primary one', async () => {
  const result = await page.evaluate(async () => {
    const mountedId = document
      .querySelector('[data-canvas-panel-id]')!
      .getAttribute('data-canvas-panel-id')!
    const nodeId = window.__cateE2E!.createTerminal({ x: 300, y: 300 })
    await new Promise((r) => setTimeout(r, 200))
    return {
      mountedId,
      nodeId,
      nodesOnMounted: window.__cateE2E!.nodes().length,
      nodeInDom: !!document.querySelector(`[data-node-id="${nodeId}"]`),
    }
  })
  // The node must exist on the canvas the user is looking at AND be rendered.
  expect(result.nodesOnMounted).toBe(1)
  expect(result.nodeInDom).toBe(true)
})

test('zoom drives the mounted canvas: store and world transform stay in lock-step', async () => {
  // Store-level zoom (toolbar/shortcut path) must move THIS canvas's world div.
  const probe = await page.evaluate(async () => {
    window.__cateE2E!.setZoom(2)
    await new Promise((r) => setTimeout(r, 200))
    const world = document.querySelector(
      '[data-canvas-panel-id] div[style*="transform-origin"]',
    ) as HTMLElement
    return { zoom: window.__cateE2E!.zoom(), transform: world.style.transform }
  })
  expect(probe.zoom).toBe(2)
  expect(probe.transform).toContain('scale(2)')
})

test('ctrl+wheel zooms the mounted canvas store (not a previous tab)', async () => {
  const probe = await page.evaluate(async () => {
    const el = document.querySelector('[data-canvas-panel-id]') as HTMLElement
    const r = el.getBoundingClientRect()
    const before = window.__cateE2E!.zoom()
    el.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -120,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    // Smooth zoom is rAF-driven; give it time to settle.
    await new Promise((res) => setTimeout(res, 800))
    return { before, after: window.__cateE2E!.zoom() }
  })
  expect(probe.before).toBe(1)
  expect(probe.after).toBeGreaterThan(1)
})

test('switching canvas tabs remounts: each canvas shows its OWN viewport', async () => {
  const tabs = await canvasTabIds(page)
  const last = tabs[tabs.length - 1]
  const secondToLast = tabs[tabs.length - 2]

  // Zoom the active (last) canvas to 3.
  await page.evaluate(() => window.__cateE2E!.setZoom(3))
  await page.waitForTimeout(100)
  expect((await mountedCanvas(page)).transform).toContain('scale(3)')

  // Switch to the second-to-last canvas tab.
  await page.click(`.dock-tab-bar [data-tab-panel-id="${secondToLast}"]`)
  await page.waitForTimeout(200)

  let mounted = await mountedCanvas(page)
  expect(mounted.id).toBe(secondToLast)
  // Its viewport is its own (zoom 1) — NOT the previous tab's scale(3).
  expect(mounted.zoom).toBe(1)
  expect(mounted.transform).toContain('scale(1)')

  // Zooming THIS canvas updates THIS canvas's world div.
  await page.evaluate(() => window.__cateE2E!.setZoom(2))
  await page.waitForTimeout(100)
  mounted = await mountedCanvas(page)
  expect(mounted.zoom).toBe(2)
  expect(mounted.transform).toContain('scale(2)')

  // Switch back: the last canvas still has its own zoom 3.
  await page.click(`.dock-tab-bar [data-tab-panel-id="${last}"]`)
  await page.waitForTimeout(200)
  mounted = await mountedCanvas(page)
  expect(mounted.id).toBe(last)
  expect(mounted.zoom).toBe(3)
  expect(mounted.transform).toContain('scale(3)')
})

test('panels created across several canvas tabs land on their own canvas', async () => {
  const tabs = await canvasTabIds(page)
  // On each of the last three canvas tabs: activate, create, assert isolation.
  for (const tabId of tabs.slice(-3)) {
    await page.click(`.dock-tab-bar [data-tab-panel-id="${tabId}"]`)
    await page.waitForTimeout(150)
    const res = await page.evaluate(async (expected) => {
      const mountedId = document
        .querySelector('[data-canvas-panel-id]')!
        .getAttribute('data-canvas-panel-id')!
      const nodeId = window.__cateE2E!.createTerminal({ x: 200, y: 200 })
      await new Promise((r) => setTimeout(r, 150))
      return {
        mountedOk: mountedId === expected,
        nodes: window.__cateE2E!.nodes().length,
        nodeInDom: !!document.querySelector(`[data-node-id="${nodeId}"]`),
      }
    }, tabId)
    expect(res.mountedOk).toBe(true)
    expect(res.nodes).toBe(1) // exactly its own node — no bleed from other tabs
    expect(res.nodeInDom).toBe(true)
  }
})
