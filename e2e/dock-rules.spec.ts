import { expect, test, type Locator } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import {
  closeApp,
  dragMouse,
  getNodeRect,
  launchApp,
  resetViewport,
  seedTerminal,
  setZoom,
  titleBarCentre,
} from './fixtures/electron-app'

let app: ElectronApplication
let page: Page
let canvasId: string

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  const window = await app.browserWindow(page)
  await window.evaluate((browserWindow) => browserWindow.setContentSize(1400, 850))
  await page.evaluate(() => window.__cateE2E!.setSidebarHidden(true))
  canvasId = await page.evaluate(() => window.__cateE2E!.activeCanvasPanelId()!)
})

test.afterEach(async () => {
  if (app) await closeApp(app)
})

function stackFor(panelId: string): Locator {
  return page.locator('[data-dock-stack-id]').filter({
    has: page.locator(`[data-tab-panel-id="${panelId}"]`),
  })
}

async function dragTabTo(panelId: string, point: { x: number; y: number }): Promise<void> {
  const box = await page.locator(`[data-tab-panel-id="${panelId}"]`).boundingBox()
  if (!box) throw new Error(`Panel tab ${panelId} is not visible`)
  await dragMouse(
    page,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    point,
    { steps: 30, pauseAtEnd: 100 },
  )
}

async function splitCanvasNode(): Promise<{
  nodeId: string
  panelIds: string[]
}> {
  await setZoom(page, 0.65)
  await resetViewport(page)
  const source = await seedTerminal(page, { x: 300, y: 100 })
  const target = await seedTerminal(page, { x: 1000, y: 100 })
  const sourceGrab = await titleBarCentre(page, source)
  const targetRect = await getNodeRect(page, target)
  if (!sourceGrab || !targetRect) throw new Error('Canvas fixture did not render')
  await dragMouse(
    page,
    sourceGrab,
    { x: targetRect.x + 12, y: targetRect.y + targetRect.height / 2 },
    { steps: 30, pauseAtEnd: 100 },
  )
  await expect(page.locator(`[data-node-id="${source}"]`)).toHaveCount(0)
  await expect.poll(async () => {
    return page.evaluate((id) => window.__cateE2E!.canvasDebug().find((node) => node.id === id)?.leafCount, target)
  }).toBe(2)
  const panelIds = await page.evaluate((id) => {
    return window.__cateE2E!.canvasDebug().find((node) => node.id === id)!.panelIds
  }, target)
  return { nodeId: target, panelIds }
}

async function promoteFirstPane(nodeId: string): Promise<void> {
  const node = page.locator(`[data-node-id="${nodeId}"]`)
  const overlay = node.locator('[data-unfocused-overlay]')
  if (await overlay.count()) await overlay.click({ position: { x: 5, y: 5 } })
  await node.getByRole('button', { name: 'Move panel into dock' }).first().click()
}

test('main-dock split can be maximized, restored, and permanently invalidated by a new split', async () => {
  await page.evaluate(() => window.__cateE2E!.clearCanvas())
  const first = await page.evaluate(() => window.__cateE2E!.createPanel('surface'))
  await stackFor(first).getByRole('button', { name: 'Split Right', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__cateE2E!.dockDebug().zones.center.leafCount)).toBe(2)

  await page.getByRole('button', { name: 'Merge splits into tabs' }).first().click()
  await expect.poll(() => page.evaluate(() => window.__cateE2E!.dockDebug())).toMatchObject({
    zones: { center: { leafCount: 1 } },
    presentation: { canRestore: true },
  })

  await page.getByRole('button', { name: 'Restore previous layout' }).click()
  await expect.poll(() => page.evaluate(() => window.__cateE2E!.dockDebug())).toMatchObject({
    zones: { center: { leafCount: 2 } },
    presentation: null,
  })

  await page.getByRole('button', { name: 'Merge splits into tabs' }).first().click()
  await page.getByRole('button', { name: 'Split Right', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__cateE2E!.dockDebug())).toMatchObject({
    zones: { center: { leafCount: 2 } },
    presentation: null,
  })
  await expect(page.getByRole('button', { name: 'Restore previous layout' })).toHaveCount(0)
})

test('a panel can move from the dock into the canvas and back into the dock', async () => {
  const panelId = await page.evaluate(() => window.__cateE2E!.createPanel('surface'))
  await page.locator(`[data-tab-panel-id="${canvasId}"]`).click()
  const canvas = await page.locator(`[data-canvas-panel-id="${canvasId}"]`).boundingBox()
  if (!canvas) throw new Error('Canvas is not visible')
  await dragTabTo(panelId, { x: canvas.x + canvas.width * 0.72, y: canvas.y + canvas.height * 0.7 })

  await expect.poll(() => page.evaluate((id) => {
    const e2e = window.__cateE2E!
    return {
      docked: e2e.dockDebug().zones.center.panelIds.includes(id),
      canvas: e2e.canvasDebug().some((node) => node.panelIds.includes(id)),
    }
  }, panelId)).toEqual({ docked: false, canvas: true })

  const nodeId = await page.evaluate((id) => {
    return window.__cateE2E!.canvasDebug().find((node) => node.panelIds.includes(id))!.id
  }, panelId)
  const grab = await titleBarCentre(page, nodeId)
  const canvasTab = await page.locator(`[data-tab-panel-id="${canvasId}"]`).boundingBox()
  if (!grab || !canvasTab) throw new Error('Dock round-trip fixture is not visible')
  await dragMouse(
    page,
    grab,
    { x: canvasTab.x + canvasTab.width / 2, y: canvasTab.y + canvasTab.height / 2 },
    { steps: 30, pauseAtEnd: 100 },
  )

  await expect.poll(() => page.evaluate((id) => {
    const e2e = window.__cateE2E!
    return {
      docked: e2e.dockDebug().zones.center.panelIds.includes(id),
      canvas: e2e.canvasDebug().some((node) => node.panelIds.includes(id)),
    }
  }, panelId)).toEqual({ docked: true, canvas: false })
})

test('a split canvas node promotes one pane and restores the exact mini-dock', async () => {
  const fixture = await splitCanvasNode()
  await promoteFirstPane(fixture.nodeId)

  await expect.poll(() => page.evaluate(() => {
    return window.__cateE2E!.dockDebug().presentation?.panelId ?? null
  })).not.toBeNull()
  const promotedId = await page.evaluate(() => window.__cateE2E!.dockDebug().presentation!.panelId!)
  expect(fixture.panelIds).toContain(promotedId)
  await expect.poll(() => page.evaluate(({ canvasId, nodeId }) => {
    return window.__cateE2E!.canvasDebug(canvasId).find((node) => node.id === nodeId)
  }, { canvasId, nodeId: fixture.nodeId })).toMatchObject({ leafCount: 1 })

  await page.getByRole('button', { name: 'Restore previous layout' }).click()
  await expect.poll(() => page.evaluate((id) => {
    return window.__cateE2E!.canvasDebug().find((node) => node.id === id)
  }, fixture.nodeId)).toMatchObject({ panelIds: fixture.panelIds, leafCount: 2 })
  await expect.poll(() => page.evaluate(() => window.__cateE2E!.dockDebug().presentation)).toBeNull()
})

test('editing the source canvas after promotion invalidates restore', async () => {
  const fixture = await splitCanvasNode()
  await promoteFirstPane(fixture.nodeId)
  await expect.poll(() => page.evaluate(() => window.__cateE2E!.dockDebug().presentation?.canRestore)).toBe(true)

  await page.locator(`[data-tab-panel-id="${canvasId}"]`).click()
  const node = page.locator(`[data-node-id="${fixture.nodeId}"]`)
  await node.getByRole('button', { name: 'New Tab' }).click()
  await page.getByRole('menu', { name: 'New Tab' }).getByRole('menuitem', { name: 'Files' }).click()

  await expect.poll(() => page.evaluate(() => window.__cateE2E!.dockDebug().presentation)).toBeNull()
  await expect(page.getByRole('button', { name: 'Restore previous layout' })).toHaveCount(0)
})

test('dragging a promoted pane back into the canvas invalidates restore', async () => {
  const fixture = await splitCanvasNode()
  await promoteFirstPane(fixture.nodeId)
  await expect.poll(() => page.evaluate(() => {
    return window.__cateE2E!.dockDebug().presentation?.panelId ?? null
  })).not.toBeNull()
  const promotedId = await page.evaluate(() => window.__cateE2E!.dockDebug().presentation!.panelId!)

  await page.locator(`[data-tab-panel-id="${canvasId}"]`).click()
  const canvas = await page.locator(`[data-canvas-panel-id="${canvasId}"]`).boundingBox()
  if (!canvas) throw new Error('Canvas is not visible')
  await dragTabTo(promotedId, { x: canvas.x + canvas.width * 0.78, y: canvas.y + canvas.height * 0.72 })

  await expect.poll(() => page.evaluate((id) => {
    const e2e = window.__cateE2E!
    return {
      presentation: e2e.dockDebug().presentation,
      inCanvas: e2e.canvasDebug().some((node) => node.panelIds.includes(id)),
    }
  }, promotedId)).toEqual({ presentation: null, inCanvas: true })
  await expect(page.getByRole('button', { name: 'Restore previous layout' })).toHaveCount(0)
})
