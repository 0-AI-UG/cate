// With no workspace, the window shows one welcome screen: the logo and the
// workspace picker right on it, to open a folder or join a workspace.

import { test, expect } from '@playwright/test'
import { closeApp, launchApp, type LaunchResult } from './fixtures/electron-app'

let app: LaunchResult | undefined
test.afterEach(async () => { await closeApp(app?.electronApp); app = undefined })

test('with no workspace, the welcome picker offers a folder or an inline pairing code', async () => {
  app = await launchApp({ workspace: false })
  const welcome = app.mainWindow.locator('[data-welcome]')
  await expect(welcome.getByRole('option', { name: /^Open Folder/ })).toBeVisible()
  await welcome.getByRole('option', { name: 'Join Workspace…' }).click()
  await expect(welcome.getByRole('textbox', { name: 'Pairing code' })).toBeVisible()
})
