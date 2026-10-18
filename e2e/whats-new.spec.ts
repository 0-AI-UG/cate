// "What's New" opens by itself once after an update, as an overlay, and
// only once: showing it remembers the version (ui-state.json).

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { closeApp, launchApp, makeHome } from './fixtures/electron-app'

test('after an update, What\'s New shows once', async () => {
  const home = makeHome()
  const userDataDir = path.join(home, 'ud')
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(path.join(userDataDir, 'ui-state.json'), JSON.stringify({ telemetryNoticeAcknowledgedVersion: 99, onboardingCompleted: true, whatsNewSeenVersion: '0.0.1' }))
  const first = await launchApp({ home, userDataDir, workspace: false })
  const whatsNew = first.mainWindow.locator('[data-whats-new]')
  await expect(whatsNew).toContainText(/Cate \d+\.\d+\.\d+/)
  await first.mainWindow.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(whatsNew).toHaveCount(0)
  await closeApp(first.electronApp, { home, keepRuntimes: true })

  const second = await launchApp({ home, userDataDir, workspace: false })
  try {
    await expect(second.mainWindow.locator('[data-welcome]')).toBeVisible()
    await second.mainWindow.waitForTimeout(1000)
    await expect(second.mainWindow.locator('[data-whats-new]')).toHaveCount(0)
  } finally {
    await closeApp(second.electronApp, { home })
  }
})
