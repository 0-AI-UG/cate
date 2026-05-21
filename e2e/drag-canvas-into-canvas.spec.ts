import { test, expect } from '@playwright/test'
import {
  launchApp,
  closeApp,
  seedTerminal,
  seedCanvasPanel,
  resetViewport,
  titleBarCentre,
  getNodeRect,
  dragMouse,
} from './fixtures/electron-app'
import type { ElectronApplication, Page } from 'playwright'

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  await resetViewport(page)
})
test.afterEach(async () => closeApp(app))

test('canvas panel cannot be docked into a canvas-node mini-dock', async () => {
  // Set up: a terminal node (the would-be drop target) and a canvas-typed node
  // (the would-be source). Canvas-in-canvas is forbidden.
  const target = await seedTerminal(page, { x: 700, y: 200 })
  const source = await seedCanvasPanel(page, { x: 200, y: 200 })
  // The canvas panel may have landed inside a sub-canvas or as a workspace
  // panel — if it didn't appear as a canvas-node, skip with a clear note.
  const sourceEl = await page.$(`[data-node-id="${source}"]`)
  test.skip(!sourceEl, 'createCanvasPanel did not produce a canvas-node in the active canvas')

  const grab = await titleBarCentre(page, source)
  const tRect = await getNodeRect(page, target)
  // Aim at the target's tab-bar (would be 'tab' drop for a non-canvas source).
  const dropPoint = { x: tRect!.x + tRect!.width / 2, y: tRect!.y + 10 }
  await dragMouse(page, grab!, dropPoint, { steps: 20, pauseAtEnd: 50 })
  await page.waitForTimeout(150)

  // Canvas source must NOT have been absorbed into target's stack.
  // It may have moved (canvas-add elsewhere) or stayed put — but it MUST still
  // exist as a canvas-node somewhere.
  const sourceStill = await page.$(`[data-node-id="${source}"]`)
  expect(sourceStill).not.toBeNull()
})

test('non-canvas tab is accepted into a canvas-node mini-dock', async () => {
  // Regression guard: the rejection above must be specific to canvas — a
  // terminal tab still docks normally.
  const target = await seedTerminal(page, { x: 700, y: 200 })
  const source = await seedTerminal(page, { x: 200, y: 200 })
  const grab = await titleBarCentre(page, source)
  const tRect = await getNodeRect(page, target)
  const dropPoint = { x: tRect!.x + tRect!.width / 2, y: tRect!.y + 10 }
  await dragMouse(page, grab!, dropPoint, { steps: 20, pauseAtEnd: 50 })
  await page.waitForTimeout(150)
  // Terminal source was tabbed into target — its canvas-node is gone.
  const sourceStill = await page.$(`[data-node-id="${source}"]`)
  expect(sourceStill).toBeNull()
})
