import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp, seedTerminal, expectTerminalText } from './fixtures/electron-app'

let app: ElectronApplication
let page: Page
let home: string

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page, home } = await launchApp())
})
test.afterEach(async () => closeApp(app, { home }))

test('app boots with the e2e harness and a connected workspace', async () => {
  expect(await page.evaluate(() => window.__cateE2E?.ready === true)).toBe(true)
  expect(await page.evaluate(() => window.__cateE2E!.connection())).toEqual({ kind: 'local', state: 'connected' })
})

test('a canvas is mounted', async () => {
  const panelId = await page.evaluate(() => window.__cateE2E!.activeCanvasPanelId())
  expect(panelId).toBeTruthy()
  await expect(page.locator('[data-canvas-container]')).toHaveCount(1)
})

test('a terminal on the canvas runs a shell in the runtime', async () => {
  const nodeId = await seedTerminal(page, { x: 200, y: 150 })
  const node = await page.evaluate((id) => window.__cateE2E!.nodes().find((n) => n.id === id), nodeId)
  expect(node).toMatchObject({ origin: { x: 200, y: 150 } })
  await page.evaluate((panelId) => window.__cateE2E!.writeTerminal(panelId, 'echo smoke-$((40+2))\r'), node!.panelId)
  await expectTerminalText(page, node!.panelId, 'smoke-42')
})
