// Detached windows. A panel is detached by placing it in a new document
// window (`placePanel {to: 'window'}`); the desktop client opens one
// BrowserWindow per detached document window and draws that window's dock.
// The panel's session never moves (13.1): only its placement changes. Moving
// the last panel out closes the window.
//
// The old per-window panel ownership (transfer, owner-routed close, the
// overview's "in another window" rows) is gone with the shared document.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { addCanvas, closeApp, launchApp, makeProject, openWorkspace } from './fixtures/electron-app'
import { layout, whereIs } from './fixtures/canvas-helpers'

let app: ElectronApplication
let main: Page
let home: string
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test.beforeEach(async () => {
  const launched = await launchApp({ workspace: false })
  ;({ electronApp: app, mainWindow: main, home } = launched)
  const project = makeProject(home, { git: true, files: { 'file.txt': 'initial content\n' } })
  await openWorkspace(main, project)
  await addCanvas(main)
})
test.afterEach(async () => { if (app) await closeApp(app, { home }) })

/** Places the panel in a new detached window; returns that window's page. */
async function detach(panelId: string): Promise<{ page: Page; windowId: string }> {
  const before = new Set(app.windows())
  const windowId = await main.evaluate((id) => {
    const windowId = crypto.randomUUID()
    const ok = window.__cateE2E!.propose({
      kind: 'placePanel',
      id,
      at: { to: 'window', windowId, stackId: crypto.randomUUID() },
    } as never).ok
    return ok ? windowId : null
  }, panelId)
  expect(windowId).toBeTruthy()
  await expect.poll(() => app.windows().filter((p) => !before.has(p)).length, { timeout: 15_000 }).toBe(1)
  const page = app.windows().find((p) => !before.has(p))!
  await page.waitForFunction(() => window.__cateE2E?.ready === true, null, { timeout: 20_000 })
  await expect(page.locator(`[data-tab-panel-id="${panelId}"]`)).toBeVisible({ timeout: 15_000 })
  return { page, windowId: windowId! }
}

for (const type of ['terminal', 'browser', 'editor', 'canvas', 'chat', 'review', 'surface'] as const) {
  test(`${type}: detaches into its own window and moves back`, async () => {
    const id = await main.evaluate((type) => window.__cateE2E!.createPanel(type), type)
    expect(id).toBeTruthy()
    await expect(main.locator(`[data-tab-panel-id="${id}"]`)).toBeVisible()

    const { page: detached, windowId } = await detach(id!)
    expect(await whereIs(main, id!)).toMatchObject({ kind: 'window', windowId })
    // Main no longer draws it; both windows read the same document.
    await expect(main.locator(`[data-tab-panel-id="${id}"]`)).toHaveCount(0)
    expect(await detached.evaluate((id) => window.__cateE2E!.panels().some((p) => p.id === id), id)).toBe(true)

    // The palette opens in the window that has focus.
    await detached.keyboard.press(`${mod}+k`)
    await expect(detached.getByRole('dialog')).toBeVisible()
    await detached.keyboard.press('Escape')
    await expect(detached.getByRole('dialog')).toHaveCount(0)

    // Moving the last panel back to main closes the detached window.
    const mainStack = (await layout(main)).windows.find((w) => w.kind === 'main')!.dock!
    const stackId = mainStack.kind === 'stack' ? mainStack.id : null
    test.skip(!stackId, 'main window dock is split')
    await main.evaluate(({ id, stackId }) => window.__cateE2E!.propose({
      kind: 'placePanel', id, at: { to: 'stack', dock: { windowId: 'main' }, stackId },
    } as never), { id, stackId })
    await expect(main.locator(`[data-tab-panel-id="${id}"]`)).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => detached.isClosed(), { timeout: 15_000 }).toBe(true)
    expect((await layout(main)).windows.map((w) => w.id)).toEqual(['main'])
  })
}

test('a detached window survives its panel being edited from main, and closes when the panel is removed', async () => {
  const id = await main.evaluate(() => window.__cateE2E!.createPanel('surface'))
  const { page: detached } = await detach(id!)
  await main.evaluate((id) => window.__cateE2E!.propose({ kind: 'updatePanel', id, patch: { title: 'Renamed from main' } } as never), id)
  await expect(detached.locator(`[data-tab-panel-id="${id}"]`)).toContainText('Renamed from main')
  await main.evaluate((id) => window.__cateE2E!.propose({ kind: 'removePanels', ids: [id] } as never), id)
  await expect.poll(() => detached.isClosed(), { timeout: 15_000 }).toBe(true)
})

test('Settings asked for in a detached window opens there, main keeps its view', async () => {
  const id = await main.evaluate(() => window.__cateE2E!.createPanel('editor'))
  const { page: detached } = await detach(id!)
  await detached.evaluate(() => window.__cateE2E!.openApplicationOverlay('settings', 'browser'))
  // Each window has its own overlays now (the old app routed them to main).
  await expect(detached.getByRole('searchbox', { name: 'Search settings' })).toBeVisible()
  await expect(main.getByRole('searchbox', { name: 'Search settings' })).toHaveCount(0)
})
