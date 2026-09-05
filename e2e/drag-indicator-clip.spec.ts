import { test, expect } from '@playwright/test'
import {
  launchApp,
  closeApp,
  seedTerminal,
  resetViewport,
  titleBarCentre,
  getNodeRect,
} from './fixtures/electron-app'
import type { ElectronApplication, Page } from 'playwright'

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  // Keep the left sidebar EXPANDED (default) so it occupies real width and the
  // canvas container starts to its right — that left strip is the region the
  // drop indicator must not paint over.
  await page.evaluate(() => window.__cateE2E!.setActiveLeftSidebarView('explorer'))
  await page.waitForTimeout(300) // 200ms width transition + margin
  await resetViewport(page)
})
test.afterEach(async () => closeApp(app))

// The split/zone drop indicator is drawn from the target stack's
// getBoundingClientRect, which ignores the canvas's `overflow-clip`. So a node
// sitting past the canvas's left edge (its left clipped under the sidebar) yields
// an indicator rect that extends under the sidebar, and it's portaled to
// document.body at z-index 10000 with no clipping. The fix clamps the indicator
// to the stack's canvas container, so it can never paint over the sidebar.
test('dock-split indicator is clamped to the canvas, never over the sidebar', async () => {
  // Target node whose origin is LEFT of the canvas edge (negative canvas-x): its
  // DOM rect — and its mini-dock drop-zone rect — extend under the sidebar.
  const target = await seedTerminal(page, { x: -150, y: 420 })
  const source = await seedTerminal(page, { x: 700, y: 420 })
  await resetViewport(page) // re-pin after auto-focus pans
  await page.waitForTimeout(150)

  const tRect = await getNodeRect(page, target)
  const grab = await titleBarCentre(page, source)
  // Aim at the target's real left edge (+12px) → dock-split-left of its mini-dock.
  // That x is under the sidebar, but resolveDockHit uses registered zone rects,
  // not elementFromPoint, so the drop still resolves there.
  await page.mouse.move(grab!.x, grab!.y)
  await page.mouse.down()
  await page.mouse.move(tRect!.x + 12, tRect!.y + tRect!.height / 2, { steps: 25 })
  await page.waitForSelector('[data-drag-indicator]', { state: 'attached', timeout: 2000 })
  await page.waitForTimeout(60)

  const diag = await page.evaluate(() => {
    const ind = document.querySelector('[data-drag-indicator]') as HTMLElement | null
    const sb = document.querySelector('[data-app-sidebar="left"]')!.getBoundingClientRect()
    const r = ind?.getBoundingClientRect() ?? null
    return {
      targetKind: window.__cateE2E!.dragSnapshot().targetKind,
      attr: ind?.getAttribute('data-drag-indicator') ?? null,
      indicatorLeft: r ? r.left : null,
      sidebarRight: sb.right,
    }
  })
  await page.mouse.up()
  await page.waitForTimeout(50)

  expect(diag.targetKind).toBe('dock-split')
  expect(diag.attr).toBe('split-left')
  // The fix: the indicator's left edge is clamped to the canvas edge (= the
  // sidebar's right edge), so it never paints over the sidebar.
  expect(diag.indicatorLeft).not.toBeNull()
  expect(diag.indicatorLeft!).toBeGreaterThanOrEqual(diag.sidebarRight - 1)
})

// Native image drags use a separate overlay from panel drags. It must inherit
// the terminal's clipping and stacking order, including the hidden left half.
test('image drop indicator stays behind the sidebar covering its terminal', async () => {
  const target = await seedTerminal(page, { x: -250, y: 100 })
  await resetViewport(page)
  const terminal = page.locator(`[data-node-id="${target}"] [data-filedrop="terminal"]`)
  await expect(terminal).toBeVisible()

  const points = await terminal.evaluate((host) => {
    const rect = host.getBoundingClientRect()
    const canvas = host.closest('[data-canvas-container]')!.getBoundingClientRect()
    const sidebar = document.querySelector('[data-app-sidebar="left"]')!.getBoundingClientRect()
    const y = rect.top + rect.height / 2
    return {
      visible: { x: Math.max(rect.left, canvas.left) + 30, y },
      covered: { x: (Math.max(rect.left, sidebar.left) + Math.min(rect.right, sidebar.right)) / 2, y },
    }
  })
  await page.evaluate(({ visible }) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['image'], 'example.png', { type: 'image/png' }))
    document.elementFromPoint(visible.x, visible.y)!.dispatchEvent(new DragEvent('dragover', {
      bubbles: true, cancelable: true, clientX: visible.x, clientY: visible.y, dataTransfer,
    }))
  }, points)
  const indicator = page.locator('[data-file-drop-indicator="terminal"]')
  await expect(indicator).toBeVisible()
  await expect(indicator).toHaveText('Drop to paste path')

  const hit = await page.evaluate(({ visible, covered }) => {
    const indicator = document.querySelector<HTMLElement>('[data-file-drop-indicator="terminal"]')!
    // Opt the visual into hit-testing to inspect the browser's paint order.
    indicator.style.pointerEvents = 'auto'
    const visibleHit = document.elementFromPoint(visible.x, visible.y)
    const coveredHit = document.elementFromPoint(covered.x, covered.y)
    indicator.style.pointerEvents = 'none'
    return {
      visibleIndicator: !!visibleHit?.closest('[data-file-drop-indicator]'),
      coveredSidebar: !!coveredHit?.closest('[data-app-sidebar="left"]'),
    }
  }, points)
  expect(hit.visibleIndicator).toBe(true)
  expect(hit.coveredSidebar).toBe(true)
  await page.evaluate(() => window.dispatchEvent(new Event('dragend')))
  await expect(indicator).toHaveCount(0)
})
