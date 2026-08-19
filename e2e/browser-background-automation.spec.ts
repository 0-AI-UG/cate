import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp } from './fixtures/electron-app'

let app: ElectronApplication
let page: Page

async function expectSurfaceAligned(panelId: string): Promise<void> {
  const geometry = await page.evaluate((id) => {
    const slot = document.querySelector(`[data-browser-surface-slot="${id}"]`)
    const surface = document.querySelector(`[data-browser-surface="${id}"]`)
    if (!(slot instanceof HTMLElement) || !(surface instanceof HTMLElement)) return null
    const slotRect = slot.getBoundingClientRect()
    const surfaceRect = surface.getBoundingClientRect()
    return {
      visible: surface.dataset.browserSurfaceVisible,
      slot: { x: slotRect.x, y: slotRect.y, width: slotRect.width, height: slotRect.height },
      surface: { x: surfaceRect.x, y: surfaceRect.y, width: surfaceRect.width, height: surfaceRect.height },
    }
  }, panelId)
  expect(geometry).not.toBeNull()
  expect(geometry?.visible).toBe('true')
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(geometry!.slot[key] - geometry!.surface[key])).toBeLessThan(1)
  }
}

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
})

test.afterEach(async () => {
  await closeApp(app)
})

test('agent-browser controls a mounted webview while its workspace is inactive', async () => {
  test.setTimeout(60_000)
  const url = `data:text/html,${encodeURIComponent(
    '<title>Background Automation</title><label for="name">Name</label><input id="name"><button id="ready">Ready</button>',
  )}`
  const browser = await page.evaluate((fixtureUrl) => (
    window.__cateE2E!.createBrowser(fixtureUrl, { x: 120, y: 120 })
  ), url)

  await expect.poll(
    () => page.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
      workspaceId,
      'readCommand',
      { panelId, command: ['snapshot', '-i'] },
    ), browser),
    { timeout: 15_000 },
  ).toMatchObject({
    ok: true,
    result: { snapshot: expect.stringContaining('button "Ready"') },
  })
  const originalWebContentsId = await expect.poll(
    () => page.evaluate((panelId) => window.__cateE2E!.browserWebContentsId(panelId), browser.panelId),
    { timeout: 15_000 },
  ).not.toBeNull().then(() => page.evaluate(
    (panelId) => window.__cateE2E!.browserWebContentsId(panelId),
    browser.panelId,
  ))
  await expect(page.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
    workspaceId,
    'command',
    { panelId, command: ['fill', '#name', 'Before workspace switch'] },
  ), browser)).resolves.toMatchObject({ ok: true })
  await expectSurfaceAligned(browser.panelId)

  const otherWorkspace = await page.evaluate(() => window.__cateE2E!.addWorkspace('Other workspace'))
  await page.evaluate((workspaceId) => window.__cateE2E!.selectWorkspace(workspaceId), otherWorkspace)

  await expect.poll(
    () => page.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
      workspaceId,
      'readCommand',
      { panelId, command: ['get', 'url'] },
    ), browser),
    { timeout: 15_000 },
  ).toEqual({ ok: true, result: { url } })

  expect(await page.evaluate(
    (panelId) => window.__cateE2E!.browserWebContentsId(panelId),
    browser.panelId,
  )).toBe(originalWebContentsId)
  await expect(page.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
    workspaceId,
    'command',
    { panelId, command: ['fill', '#name', 'Filled from another workspace'] },
  ), browser)).resolves.toMatchObject({ ok: true })

  await page.evaluate((workspaceId) => window.__cateE2E!.selectWorkspace(workspaceId), browser.workspaceId)
  expect(await page.evaluate(
    (panelId) => window.__cateE2E!.browserWebContentsId(panelId),
    browser.panelId,
  )).toBe(originalWebContentsId)
  await expectSurfaceAligned(browser.panelId)
  await expect(page.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
    workspaceId,
    'readCommand',
    { panelId, command: ['get', 'value', '#name'] },
  ), browser)).resolves.toEqual({
    ok: true,
    result: { value: 'Filled from another workspace' },
  })
})
