import { expect, test, type Locator } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, dragMouse, launchApp } from './fixtures/electron-app'

let app: ElectronApplication
let page: Page
let firstPanel: string

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  const window = await app.browserWindow(page)
  await window.evaluate(window => window.setContentSize(1040, 700))
  firstPanel = await page.evaluate(() => {
    window.__cateE2E!.setSidebarHidden(true)
    window.__cateE2E!.clearCanvas()
    return window.__cateE2E!.createPanel('surface')
  })
  await expect(page.locator(`[data-tab-panel-id="${firstPanel}"]`)).toBeVisible()
})
test.afterEach(async () => { if (app) await closeApp(app) })

function stackFor(panelId: string): Locator {
  return page.locator('[data-dock-stack-id]').filter({ has: page.locator(`[data-tab-panel-id="${panelId}"]`) })
}

async function expectVisibleThirds() {
  await expect(page.locator('[data-dock-stack-id]')).toHaveCount(3)
  await expect.poll(async () => page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-dock-viewport]')!
    const bounds = viewport.getBoundingClientRect()
    const panes = [...viewport.querySelectorAll<HTMLElement>('[data-dock-stack-id]')].map(pane => pane.getBoundingClientRect())
    return panes.length === 3
      && viewport.scrollWidth <= viewport.clientWidth + 1
      && panes.every(pane => pane.width >= 319 && pane.height > 100 && pane.left >= bounds.left - 1 && pane.right <= bounds.right + 1)
      && Math.max(...panes.map(pane => pane.width)) - Math.min(...panes.map(pane => pane.width)) <= 1
      && panes.every((pane, i) => i === 0 || pane.left >= panes[i - 1].right)
  })).toBe(true)
  for (const picker of await page.getByRole('group', { name: 'Open a surface' }).all()) await expect(picker).toBeVisible()
}

test('Split Right supports equal thirds without enlarging the window', async () => {
  await stackFor(firstPanel).getByRole('button', { name: 'Split Right', exact: true }).click()
  await expect(page.locator('[data-dock-stack-id]')).toHaveCount(2)
  const right = page.locator('[data-dock-stack-id]').nth(1)
  // Each half is too narrow for two 320px panes, but the entire row fits three.
  expect((await right.boundingBox())!.width).toBeLessThan(645)
  await expect(right.getByRole('button', { name: 'Split Right', exact: true })).toBeEnabled()
  const windowWidth = await page.evaluate(() => window.innerWidth)
  await right.getByRole('button', { name: 'Split Right', exact: true }).click()
  await expectVisibleThirds()
  expect(await page.evaluate(() => window.innerWidth)).toBe(windowWidth)
})

test('dropping a third tab on the left edge of the second half keeps every pane visible', async () => {
  await stackFor(firstPanel).getByRole('button', { name: 'Split Right', exact: true }).click()
  await expect(page.locator('[data-dock-stack-id]')).toHaveCount(2)
  const originalPanels = await page.locator('[data-tab-panel-id]').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('data-tab-panel-id')!))
  const targetId = await page.locator('[data-dock-stack-id]').nth(1).getAttribute('data-dock-stack-id')
  const third = await page.evaluate(() => window.__cateE2E!.createPanel('surface'))
  const tab = page.locator(`[data-tab-panel-id="${third}"]`)
  await expect(tab).toBeVisible()
  const source = (await tab.boundingBox())!
  const target = (await page.locator(`[data-dock-stack-id="${targetId}"]`).boundingBox())!
  const windowWidth = await page.evaluate(() => window.innerWidth)
  await dragMouse(page, { x: source.x + source.width / 2, y: source.y + source.height / 2 },
    { x: target.x + 12, y: target.y + target.height / 2 }, { steps: 25, pauseAtEnd: 100 })
  await expectVisibleThirds()
  for (const panel of [...originalPanels, third]) await expect(page.locator(`[data-tab-panel-id="${panel}"]`)).toBeVisible()
  const order = await page.locator('[data-dock-stack-id]').evaluateAll(stacks => stacks.map(stack => stack.querySelector('[data-tab-panel-id]')!.getAttribute('data-tab-panel-id')))
  expect(order).toEqual([originalPanels[0], third, originalPanels[1]])
  expect(await page.evaluate(() => window.innerWidth)).toBe(windowWidth)
})
