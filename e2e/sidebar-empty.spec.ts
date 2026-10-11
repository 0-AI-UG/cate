// With no workspace, the window shows one welcome screen: the logo, the Open
// picker (opening or joining a workspace) and what is new in this version.

import { test, expect } from '@playwright/test'
import { closeApp, launchApp, type LaunchResult } from './fixtures/electron-app'

let app: LaunchResult | undefined
test.afterEach(async () => { await closeApp(app?.electronApp); app = undefined })

test('with no workspace, the welcome screen shows what is new and opens or joins one', async () => {
  app = await launchApp({ workspace: false })
  const welcome = app.mainWindow.locator('[data-welcome]')
  await expect(welcome.locator('[data-whats-new]')).toContainText(/Cate \d+\.\d+\.\d+/)
  await expect(welcome.getByRole('button', { name: 'Full changelog' })).toBeVisible()
  await welcome.getByRole('option', { name: /Join with a code/ }).click()
  await expect(app.mainWindow.locator('[role="dialog"]')).toHaveCount(1)
})
