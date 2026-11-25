// The sidebar lists the workspaces open on this device, across restarts.
// Closing one disconnects it and drops it; the window shows its neighbour,
// or the welcome screen when none is left.

import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { closeApp, launchApp, makeHome, makeProject, openWorkspace } from './fixtures/electron-app'

const row = (page: Page, id: string) => page.locator(`[data-app-sidebar] [data-workspace-id="${id}"] [role="treeitem"]`)
const selected = (page: Page) => page.evaluate(() => window.__cateE2E!.selectedWorkspaceId())

async function close(page: Page, id: string) {
  await row(page, id).click({ modifiers: ['ControlOrMeta'] })
  await page.keyboard.press('Delete')
  await expect(row(page, id)).toHaveCount(0)
}

test('closing a workspace drops it from the sidebar, and the sidebar survives a restart', async () => {
  const home = makeHome()
  const userDataDir = path.join(home, 'ud')
  const first = await launchApp({ home, userDataDir, workspace: false })
  let a = '', b = '', c = ''
  try {
    const page = first.mainWindow
    a = await openWorkspace(page, makeProject(home, { name: 'alpha' }))
    b = await openWorkspace(page, makeProject(home, { name: 'beta' }))
    c = await openWorkspace(page, makeProject(home, { name: 'gamma' }))

    // The shown one closes: its neighbour shows.
    await page.evaluate((id) => window.__cateE2E!.selectWorkspace(id), b)
    await close(page, b)
    await expect.poll(() => selected(page)).toBe(c)
    expect(await page.evaluate(() => window.__cateE2E!.workspaceIds())).toEqual([a, c])
  } finally { await closeApp(first.electronApp) }

  const second = await launchApp({ home, userDataDir, workspace: false })
  try {
    const page = second.mainWindow
    await expect(row(page, a)).toBeVisible()
    await expect(row(page, c)).toBeVisible()
    await expect(row(page, b)).toHaveCount(0)

    await close(page, c)
    await close(page, a)
    await expect(page.locator('[data-welcome]')).toBeVisible()
    await expect(page.locator('[data-app-sidebar]').getByText('No workspaces yet')).toBeVisible()
    expect(await page.evaluate(() => window.__cateE2E!.workspaceIds())).toEqual([])
  } finally { await closeApp(second.electronApp, { home }) }
})
