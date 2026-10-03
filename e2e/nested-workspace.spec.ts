// Workspaces never nest. Opening a folder inside an open workspace says which
// workspace it is inside, offers that one, and leaves no broken entry behind.
// Nothing covers the app: only the nested workspace's own content.

import { test, expect } from '@playwright/test'
import { mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { closeApp, launchApp, type LaunchResult } from './fixtures/electron-app'

let app: LaunchResult | undefined
test.afterEach(async () => { await closeApp(app?.electronApp); app = undefined })

/** Adds a folder without waiting for it to open (a refused one never does). */
const addFolder = (app: LaunchResult, root: string) =>
  app.mainWindow.evaluate((root) => { void window.__cateE2E!.addWorkspace(undefined, root) }, root)

const entries = (app: LaunchResult) => app.mainWindow.evaluate(() => window.__cateE2E!.workspaceIds())

test('a folder inside the open workspace explains itself and offers the open one', async () => {
  app = await launchApp({ workspace: true, canvas: false })
  const outer = app.project!
  const outerId = app.workspaceId!
  const inner = path.join(outer, 'packages', 'app')
  mkdirSync(inner, { recursive: true })

  await addFolder(app, realpathSync(inner))
  const page = app.mainWindow
  const blocker = page.locator('[data-connection-blocker]')
  await expect(blocker).toContainText(`is inside the workspace ${outer}, which is already open in Cate`, { timeout: 30_000 })
  await expect(page.locator('[role="dialog"]')).toHaveCount(0)
  await expect(page.locator('[data-connection-status]')).toHaveAttribute('aria-label', /is inside the workspace/)

  await blocker.getByRole('button', { name: `Open ${path.basename(outer)}` }).click()
  await expect.poll(() => page.evaluate(() => window.__cateE2E!.selectedWorkspaceId())).toBe(outerId)
  await expect.poll(() => entries(app!)).toEqual([outerId])
  await expect(blocker).toHaveCount(0)
})

test('a folder around the open workspace can be removed from the list again', async () => {
  app = await launchApp({ workspace: true, canvas: false })
  const around = path.dirname(app.project!)

  await addFolder(app, around)
  const page = app.mainWindow
  const blocker = page.locator('[data-connection-blocker]')
  await expect(blocker).toContainText(`contains the workspace ${app.project!}`, { timeout: 30_000 })
  await blocker.getByRole('button', { name: 'Remove from list' }).click()
  await expect.poll(() => entries(app!)).toEqual([app!.workspaceId])
})
