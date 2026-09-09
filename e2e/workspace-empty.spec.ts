import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, closeApp } from './fixtures/electron-app'
import { openTrustedWorkspace } from './fixtures/workspace'

test('the shell owns project selection and an empty project has no implicit panels', async () => {
  const { electronApp, mainWindow: page } = await launchApp({ empty: true })
  try {
    const welcome = page.locator('[data-onboarding="welcome-actions"]')
    const emptyDock = page.locator('[data-empty-workspace-dock]')
    await expect(welcome).toBeVisible()
    await expect(page.locator('[data-empty-screen-grid]')).toBeVisible()
    expect(await page.evaluate(() => window.__cateE2E!.panels())).toEqual([])
    await expect(page.locator('[data-canvas-panel-id]')).toHaveCount(0)
    await page.screenshot({ path: '/tmp/cate-workspace-chooser.png' })
    const directory = mkdtempSync(path.join(tmpdir(), 'cate-empty-project-'))
    await openTrustedWorkspace(page, directory)
    await expect(emptyDock).toBeVisible()
    await expect(welcome).toHaveCount(0)
    expect(await page.evaluate(() => window.__cateE2E!.panels())).toEqual([])
    await page.screenshot({ path: '/tmp/cate-empty-dock.png' })
    await emptyDock.getByRole('button', { name: 'Canvas', exact: true }).click()
    await expect(page.locator('[data-canvas-panel-id]')).toHaveCount(1)
    await expect(welcome).toHaveCount(0)
    await page.evaluate(() => window.__cateE2E!.createTerminal({ x: 80, y: 80 }))
    // Wait for the non-empty layout to reach disk before clearing it: empty
    // saves must replace a previously saved layout, not just initialize one.
    await expect.poll(() => {
      try { return Object.keys(JSON.parse(readFileSync(path.join(directory, '.cate/workspace.json'), 'utf8')).panels ?? {}).length }
      catch { return 0 }
    }).toBeGreaterThan(1)
    await page.evaluate(() => window.__cateE2E!.clearCanvas())
    await expect(emptyDock).toBeVisible()
    const original = await page.evaluate(() => window.__cateE2E!.selectedWorkspaceId())
    await page.evaluate(async () => {
      const other = window.__cateE2E!.addWorkspace('New workspace')
      await window.__cateE2E!.selectWorkspace(other)
    })
    await expect(welcome).toBeVisible()
    await page.evaluate((id) => window.__cateE2E!.selectWorkspace(id), original)
    await expect(emptyDock).toBeVisible()
    expect(await page.evaluate(() => window.__cateE2E!.panels())).toEqual([])
    await expect.poll(() => {
      try { return Object.keys(JSON.parse(readFileSync(path.join(directory, '.cate/workspace.json'), 'utf8')).panels ?? {}) }
      catch { return null }
    }, { timeout: 10_000 }).toEqual([])
    await page.reload()
    await expect(emptyDock).toBeVisible()
    await expect(page.locator('[data-canvas-panel-id]')).toHaveCount(0)
  } finally { await closeApp(electronApp) }
})

for (const [label, type] of [['New Terminal', 'terminal'], ['New T3 Panel', 'agent'], ['New Files Panel', 'editor'], ['New Browser', 'browser']] as const) {
  test(`chooser ${label} opens inside a canvas`, async () => {
    const { electronApp, mainWindow: page } = await launchApp({ empty: true })
    try {
      const directory = mkdtempSync(path.join(tmpdir(), 'cate-start-panel-'))
      await electronApp.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
      }, directory)
      await page.getByRole('button', { name: new RegExp(label) }).click()
      await page.getByRole('button', { name: 'Trust and open' }).click()
      await expect(page.locator('[data-canvas-panel-id]')).toHaveCount(1)
      await expect.poll(() => page.evaluate(() => window.__cateE2E!.panelTypes())).toEqual(expect.arrayContaining(['canvas', type]))
      const id = await page.evaluate((panelType) => window.__cateE2E!.panels().find((p) => p.type === panelType)!.id, type)
      await expect.poll(() => page.evaluate((panelId) => window.__cateE2E!.nodeForPanel(panelId), id)).not.toBeNull()
      await expect(page.locator('[data-empty-workspace-dock]')).toHaveCount(0)
    } finally { await closeApp(electronApp) }
  })
}

for (const [label, type] of [['Files', 'editor'], ['Terminal', 'terminal'], ['Browser', 'browser'], ['Canvas', 'canvas'], ['T3 Code', 'agent'], ['Diff Review', 'review']] as const) {
  test(`empty dock ${label} opens directly in the dock`, async () => {
    const { electronApp, mainWindow: page } = await launchApp({ empty: true })
    try {
      await openTrustedWorkspace(page, mkdtempSync(path.join(tmpdir(), 'cate-dock-surface-')))
      const picker = page.locator('[data-empty-workspace-dock]').getByRole('group', { name: 'Open a surface' })
      await expect(picker.getByRole('button')).toHaveCount(6)
      await picker.getByRole('button', { name: type === 'agent' ? /T3 Code/ : label, exact: type !== 'agent' }).click()
      await expect.poll(() => page.evaluate(() => window.__cateE2E!.panelTypes())).toEqual([type])
      await expect(page.locator('[data-canvas-panel-id]')).toHaveCount(type === 'canvas' ? 1 : 0)
      await expect(page.locator('[data-empty-workspace-dock]')).toHaveCount(0)
    } finally { await closeApp(electronApp) }
  })
}

test('Source Control and Settings create directly in an empty dock', async () => {
  const { electronApp, mainWindow: page } = await launchApp({ empty: true })
  try {
    const directory = mkdtempSync(path.join(tmpdir(), 'cate-empty-overlay-'))
    execFileSync('git', ['init', directory])
    writeFileSync(path.join(directory, 'file.txt'), 'before\n')
    execFileSync('git', ['-C', directory, 'add', 'file.txt'])
    execFileSync('git', ['-C', directory, '-c', 'user.name=Cate Test', '-c', 'user.email=test@cate.local', 'commit', '-m', 'Initial'])
    writeFileSync(path.join(directory, 'file.txt'), 'after\n')
    await openTrustedWorkspace(page, directory)
    await page.getByRole('button', { name: 'Repository', exact: true }).click()
    await page.getByRole('button', { name: 'Review changes', exact: true }).first().click()
    await expect.poll(() => page.evaluate(() => window.__cateE2E!.panelTypes())).toEqual(['review'])
    await expect(page.locator('[data-canvas-panel-id]')).toHaveCount(0)
    await page.evaluate(() => window.__cateE2E!.clearCanvas())
    await page.evaluate(() => window.__cateE2E!.openSettings())
    await page.getByRole('button', { name: 'Open settings.json', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__cateE2E!.panelTypes())).toEqual(['editor'])
    await expect(page.locator('[data-canvas-panel-id]')).toHaveCount(0)
  } finally { await closeApp(electronApp) }
})
