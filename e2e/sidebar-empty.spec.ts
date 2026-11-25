// With no workspace, the window shows one welcome screen: the logo and the
// workspace picker right on it, to open a folder or join a workspace.

import { test, expect } from '@playwright/test'
import { closeApp, launchApp, type LaunchResult } from './fixtures/electron-app'

let app: LaunchResult | undefined
test.afterEach(async () => { await closeApp(app?.electronApp); app = undefined })

test('with no workspace, the welcome screen shows the picker and opens or joins one', async () => {
  app = await launchApp({ workspace: false })
  const welcome = app.mainWindow.locator('[data-welcome]')
  await expect(welcome.getByRole('option', { name: /Open a folder/ })).toBeVisible()
  await welcome.getByRole('option', { name: 'Join with a code…' }).click()
  await expect(app.mainWindow.locator('[role="dialog"]')).toHaveCount(1)
})
