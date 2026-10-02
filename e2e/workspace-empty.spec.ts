// Project selection and empty workspaces. Without a workspace the welcome
// page shows; an opened project has no implicit panels, and an emptied
// document stays empty across a restart (the runtime's document.json).

import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { addCanvas, closeApp, launchApp, makeHome, makeProject, openWorkspace, seedOnCanvas } from './fixtures/electron-app'

const welcome = '[data-onboarding="welcome-actions"]'

function documentFile(home: string): string {
  const dir = path.join(home, '.cate', 'workspaces')
  return path.join(dir, readdirSync(dir)[0]!, 'document.json')
}

test('the shell owns project selection and an empty project has no implicit panels', async () => {
  const home = makeHome()
  const userDataDir = path.join(home, 'ud')
  const first = await launchApp({ home, userDataDir, workspace: false })
  let firstOpen = true
  try {
    const page = first.mainWindow
    await expect(page.locator(welcome)).toBeVisible()
    expect(await page.evaluate(() => window.__cateE2E!.panels())).toEqual([])
    await expect(page.locator('[data-canvas-panel-id]')).toHaveCount(0)

    const project = makeProject(home)
    await openWorkspace(page, project)
    await expect(page.locator(welcome)).toHaveCount(0)
    expect(await page.evaluate(() => window.__cateE2E!.panels())).toEqual([])
    await expect(page.locator('[data-dock-window="main"]')).toBeVisible()

    await addCanvas(page)
    await seedOnCanvas(page, 'terminal', { x: 80, y: 80 })
    // The non-empty document reaches disk before it is emptied, so the empty
    // save must replace saved workspace state, not just initialize it.
    const panelsOnDisk = () => {
      try { return Object.keys((JSON.parse(readFileSync(documentFile(home), 'utf8')) as { document?: { panels?: object }; panels?: object }).document?.panels ?? (JSON.parse(readFileSync(documentFile(home), 'utf8')) as { panels?: object }).panels ?? {}).length }
      catch { return -1 }
    }
    await expect.poll(panelsOnDisk, { timeout: 10_000 }).toBeGreaterThan(1)
    await page.evaluate(() => {
      const ids = window.__cateE2E!.panels().map((p) => p.id)
      window.__cateE2E!.propose({ kind: 'removePanels', ids } as never)
    })
    await expect.poll(() => page.evaluate(() => window.__cateE2E!.panels().length)).toBe(0)
    await expect.poll(panelsOnDisk, { timeout: 10_000 }).toBe(0)

    // Another workspace, then back: still empty.
    const original = await page.evaluate(() => window.__cateE2E!.selectedWorkspaceId())
    await openWorkspace(page, makeProject(home, { name: 'other' }))
    await page.evaluate((id) => window.__cateE2E!.selectWorkspace(id!), original)
    await expect.poll(() => page.evaluate(() => window.__cateE2E!.selectedWorkspaceId())).toBe(original)
    expect(await page.evaluate(() => window.__cateE2E!.panels())).toEqual([])
    await closeApp(first.electronApp)
    firstOpen = false

    // A restart on the same device and HOME restores the (empty) workspace.
    const second = await launchApp({ home, userDataDir, workspace: false })
    try {
      await expect.poll(() => second.mainWindow.evaluate(() => window.__cateE2E!.selectedWorkspaceId()), { timeout: 20_000 }).toBe(original)
      await second.mainWindow.waitForFunction((ws) => !!window.__cateE2E!.document(ws), original)
      expect(await second.mainWindow.evaluate(() => window.__cateE2E!.panels())).toEqual([])
      await expect(second.mainWindow.locator('[data-canvas-panel-id]')).toHaveCount(0)
    } finally { await closeApp(second.electronApp) }
  } finally {
    await closeApp(firstOpen ? first.electronApp : undefined, { home })
  }
})

test('an empty main window offers a way to open a panel', async () => {
  const { electronApp, mainWindow: page } = await launchApp({ canvas: false })
  try {
    await expect(page.locator('[data-dock-window="main"]').getByRole('group', { name: 'Open a surface' })).toBeVisible()
  } finally { await closeApp(electronApp) }
})

async function reviewFromRepository(canonical: boolean) {
  const home = makeHome()
  const created = makeProject(home, { git: true, files: { 'file.txt': 'before\n' } })
  execFileSync('git', ['-C', created, 'add', '.'])
  execFileSync('git', ['-C', created, '-c', 'user.email=e2e@cate.test', '-c', 'user.name=e2e', 'commit', '-qm', 'file'])
  const project = canonical ? realpathSync(created) : created
  const { electronApp, mainWindow: page } = await launchApp({ home, workspace: project, canvas: false })
  try {
    writeFileSync(path.join(project, 'file.txt'), 'after\n')
    await page.getByRole('button', { name: 'Repository', exact: true }).click()
    await page.getByRole('button', { name: 'Review changes', exact: true }).first().click({ timeout: 15_000 })
    await expect.poll(() => page.evaluate(() => window.__cateE2E!.panelTypes())).toEqual(['review'])
    await expect(page.locator('[data-canvas-panel-id]')).toHaveCount(0)
  } finally { await closeApp(electronApp, { home }) }
}

test('Review changes from the Repository overview opens directly in an empty dock', async () => {
  await reviewFromRepository(true)
})

test('the Repository overview works for a project opened through a symlinked path', async () => {
  // /tmp is a symlink to /private/tmp on macOS: the Repository UI must use
  // the runtime's canonical root, not the path the project was opened with.
  await reviewFromRepository(false)
})
