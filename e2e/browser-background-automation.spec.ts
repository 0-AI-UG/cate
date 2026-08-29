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

test('persistent browser surfaces respect canvas clipping and canvas node order', async () => {
  const browser = await page.evaluate(() => (
    window.__cateE2E!.createBrowser('data:text/html,<title>Stacking test</title>', { x: -100, y: 120 })
  ))

  await expect.poll(() => page.evaluate((panelId) => {
    const surface = document.querySelector<HTMLElement>(`[data-browser-surface="${panelId}"]`)
    return surface?.dataset.browserSurfaceVisible
  }, browser.panelId)).toBe('true')

  const clippedUnderSidebar = await page.evaluate((panelId) => {
    const sidebar = document.querySelector<HTMLElement>('[data-app-sidebar="left"]')!
    const surface = document.querySelector<HTMLElement>(`[data-browser-surface="${panelId}"]`)!
    const sidebarRect = sidebar.getBoundingClientRect()
    const surfaceRect = surface.getBoundingClientRect()
    const x = Math.min(sidebarRect.right - 10, surfaceRect.right - 10)
    const y = surfaceRect.top + Math.min(100, surfaceRect.height / 2)
    return document.elementFromPoint(x, y)?.closest('[data-app-sidebar="left"]') !== null
  }, browser.panelId)
  expect(clippedUnderSidebar).toBe(true)

  const browserNodeId = await page.evaluate(
    (panelId) => window.__cateE2E!.nodeForPanel(panelId),
    browser.panelId,
  )
  expect(browserNodeId).not.toBeNull()
  const terminalNodeId = await page.evaluate(() => window.__cateE2E!.createTerminal({ x: 200, y: 180 }))
  await page.evaluate(({ browserNodeId, terminalNodeId }) => {
    window.__cateE2E!.resetViewport()
    window.__cateE2E!.moveNode(browserNodeId!, { x: 100, y: 120 })
    window.__cateE2E!.moveNode(terminalNodeId, { x: 200, y: 180 })
  }, { browserNodeId, terminalNodeId })

  await page.waitForSelector(`[data-node-id="${terminalNodeId}"]`)
  await expect.poll(() => page.evaluate(({ panelId, terminalNodeId }) => {
    const surface = document.querySelector<HTMLElement>(`[data-browser-surface="${panelId}"]`)
    const terminal = document.querySelector<HTMLElement>(`[data-node-id="${terminalNodeId}"]`)
    if (!surface || !terminal || !surface.style.clipPath.startsWith('path(')) return false
    const a = surface.getBoundingClientRect()
    const b = terminal.getBoundingClientRect()
    const left = Math.max(a.left, b.left)
    const top = Math.max(a.top, b.top)
    const right = Math.min(a.right, b.right)
    const bottom = Math.min(a.bottom, b.bottom)
    if (right <= left || bottom <= top) return false
    return document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
      ?.closest('[data-node-id]')
      ?.getAttribute('data-node-id') === terminalNodeId
  }, { panelId: browser.panelId, terminalNodeId })).toBe(true)
})
