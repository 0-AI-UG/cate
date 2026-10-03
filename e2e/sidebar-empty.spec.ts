// With no workspace yet, the sidebar offers buttons to open or join one.

import { test, expect } from '@playwright/test'
import { closeApp, launchApp, type LaunchResult } from './fixtures/electron-app'

let app: LaunchResult | undefined
test.afterEach(async () => { await closeApp(app?.electronApp); app = undefined })

test('the empty sidebar offers to open a workspace or join one', async () => {
  app = await launchApp({ workspace: false })
  const empty = app.mainWindow.locator('[data-sidebar-empty]')
  await expect(empty.getByRole('button', { name: 'Open Workspace…' })).toBeVisible()
  await empty.getByRole('button', { name: 'Join a Workspace' }).click()
  await expect(app.mainWindow.locator('[role="dialog"]')).toHaveCount(1)
})
