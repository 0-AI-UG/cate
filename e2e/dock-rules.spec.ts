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
import { mainWindowStacks, nodePanels, whereIs } from './fixtures/canvas-helpers'

let app: ElectronApplication
let page: Page
let canvasId: string

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  const window = await app.browserWindow(page)
  await window.evaluate((browserWindow) => browserWindow.setContentSize(1400, 850))
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

/** What the main window draws, and whether a restore is offered. */
async function drawn() {
  return page.evaluate(() => {
    const win = document.querySelector('[data-dock-window="main"]')
    const outsideNodes = (el: Element) => !el.closest('[data-node-id]')
    const stacks = win ? [...win.querySelectorAll('[data-dock-stack-id]')].filter(outsideNodes) : []
    const tabs = stacks.flatMap((stack) => [...stack.querySelectorAll('[data-tab-panel-id]')].filter(outsideNodes).map((t) => t.getAttribute('data-tab-panel-id')!))
    return { mainLeaves: stacks.length, mainTabs: [...new Set(tabs)], canRestore: !!document.querySelector('[aria-label="Restore"]') }
  })
}

async function drawnNode(nodeId: string) {
  return page.evaluate((id) => {
    const node = document.querySelector(`[data-node-id="${id}"]`)
    if (!node) return null
    const panelIds = [...node.querySelectorAll('[data-tab-panel-id]')].map((t) => t.getAttribute('data-tab-panel-id')!)
    return { leafCount: node.querySelectorAll('[data-dock-stack-id]').length, panelIds: [...new Set(panelIds)] }
  }, nodeId)
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
  await expect.poll(async () => (await drawnNode(target))?.leafCount).toBe(2)
  const panelIds = await nodePanels(page, target)
  expect(panelIds).toHaveLength(2)
  return { nodeId: target, panelIds }
}

test('a main-dock stack can be maximized and restored, for this client only', async () => {
  // Empty the main window: remove the canvas panel.
  await page.evaluate((id) => window.__cateE2E!.propose({ kind: 'removePanels', ids: [id] } as never), canvasId)
  const first = await page.evaluate(() => window.__cateE2E!.createPanel('surface'))
  await stackFor(first!).getByRole('button', { name: 'Split Right', exact: true }).click()
  await expect.poll(async () => (await drawn()).mainLeaves).toBe(2)
  expect(await mainWindowStacks(page)).toHaveLength(2)

  // Maximize is client state: one stack drawn, the document's tree unchanged.
  await page.getByRole('button', { name: 'Maximize', exact: true }).first().click()
  await expect.poll(async () => { const d = await drawn(); return { leaves: d.mainLeaves, canRestore: d.canRestore } }).toEqual({ leaves: 1, canRestore: true })
  expect(await mainWindowStacks(page)).toHaveLength(2)

  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect.poll(async () => { const d = await drawn(); return { leaves: d.mainLeaves, canRestore: d.canRestore } }).toEqual({ leaves: 2, canRestore: false })
})

test('a panel can move from the dock into the canvas and back into the dock', async () => {
  const panelId = await page.evaluate(() => window.__cateE2E!.createPanel('surface'))
  await page.locator(`[data-tab-panel-id="${canvasId}"]`).click()
  const canvas = await page.locator(`[data-canvas-panel-id="${canvasId}"]`).boundingBox()
  if (!canvas) throw new Error('Canvas is not visible')
  await dragTabTo(panelId!, { x: canvas.x + canvas.width * 0.72, y: canvas.y + canvas.height * 0.7 })

  await expect.poll(async () => (await whereIs(page, panelId!))?.kind).toBe('canvas')
  const nodeId = (await whereIs(page, panelId!))!.nodeId!
  const grab = await titleBarCentre(page, nodeId)
  const canvasTab = await page.locator(`[data-tab-panel-id="${canvasId}"]`).boundingBox()
  if (!grab || !canvasTab) throw new Error('Dock round-trip fixture is not visible')
  await dragMouse(
    page,
    grab,
    { x: canvasTab.x + canvasTab.width / 2, y: canvasTab.y + canvasTab.height / 2 },
    { steps: 30, pauseAtEnd: 100 },
  )

  await expect.poll(async () => (await whereIs(page, panelId!))).toMatchObject({ kind: 'window', windowId: 'main' })
})

test('a canvas node can be maximized over its canvas and restored, for this client only', async () => {
  const fixture = await splitCanvasNode()
  const node = page.locator(`[data-node-id="${fixture.nodeId}"]`)
  const overlay = node.locator('[data-unfocused-overlay]')
  if (await overlay.count()) await overlay.click({ position: { x: 5, y: 5 } })
  await node.getByRole('button', { name: 'Maximize', exact: true }).first().click()

  const maximized = page.locator(`[data-maximized-node="${fixture.nodeId}"]`)
  await expect(maximized).toBeVisible()
  await expect(maximized.locator('[data-dock-stack-id]')).toHaveCount(2)
  await expect(page.locator(`[data-node-id="${fixture.nodeId}"]`)).toHaveCount(0)
  // The document still has the node as it was.
  expect([...await nodePanels(page, fixture.nodeId)].sort()).toEqual([...fixture.panelIds].sort())

  await maximized.getByRole('button', { name: 'Restore', exact: true }).first().click()
  await expect(maximized).toHaveCount(0)
  await expect.poll(async () => (await drawnNode(fixture.nodeId))?.leafCount).toBe(2)
})
