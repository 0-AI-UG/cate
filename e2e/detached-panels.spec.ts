import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, closeApp } from './fixtures/electron-app'
import { openTrustedWorkspace } from './fixtures/workspace'

let app: ElectronApplication
let main: Page
let directory: string
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()

test.beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'cate-detached-panels-'))
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Panel Test')
  writeFileSync(path.join(directory, 'file.txt'), 'initial content\n')
  git('add', '.'); git('commit', '-m', 'Initial')
  ;({ electronApp: app, mainWindow: main } = await launchApp())
  await openTrustedWorkspace(main, directory)
})
test.afterEach(async () => { if (app) await closeApp(app); rmSync(directory, { recursive: true, force: true }) })

async function detach(id: string): Promise<Page> {
  const before = new Set(app.windows())
  expect(await main.evaluate(id => window.__cateE2E!.detachPanel(id), id)).toBe(true)
  await expect.poll(() => app.windows().filter(page => !before.has(page)).length).toBe(1)
  const detached = app.windows().find(page => !before.has(page))!
  await detached.waitForFunction(() => window.__cateE2E?.ready)
  await expect(detached.locator(`[data-tab-panel-id="${id}"]`)).toBeVisible()
  return detached
}

test('Cmd+K works locally and Settings requests open only in main', async () => {
  const id = await main.evaluate(() => window.__cateE2E!.createPanel('editor'))
  const detached = await detach(id)
  await detached.keyboard.press(`${mod}+k`)
  await expect(detached.getByRole('dialog')).toBeVisible()
  await expect(detached.getByText('New Terminal', { exact: true })).toBeVisible()
  await detached.keyboard.press('Escape')
  await expect(detached.getByRole('dialog')).toHaveCount(0)
  await detached.evaluate(() => window.__cateE2E!.openApplicationOverlay('settings', 'browser'))
  await expect(main.getByRole('searchbox', { name: 'Search settings' })).toBeVisible()
  await expect(detached.getByRole('searchbox', { name: 'Search settings' })).toHaveCount(0)
  await expect(detached.locator('[data-tab-panel-id]')).toBeVisible()
})

test('Files root terminal action places the terminal in the visible detached dock', async () => {
  const id = await main.evaluate(() => window.__cateE2E!.createPanel('editor'))
  const detached = await detach(id)
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('menu:showContext'); ipcMain.handle('menu:showContext', () => 'open-terminal') })
  const tree = detached.locator('[data-sidebar-keynav]').first()
  await expect(tree).toBeVisible()
  await tree.dispatchEvent('contextmenu')
  await expect.poll(() => detached.evaluate(() => window.__cateE2E!.panels().filter(p => p.type === 'terminal').length)).toBe(1)
  const terminal = await detached.evaluate(() => window.__cateE2E!.panels().find(p => p.type === 'terminal')!.id)
  await expect(detached.locator(`[data-tab-panel-id="${terminal}"]`)).toBeVisible()
})

async function chooseNativeMenu(choice: string) {
  await app.evaluate(({ ipcMain }, choice) => {
    ipcMain.removeHandler('menu:showContext')
    ipcMain.handle('menu:showContext', (_event, items) => {
      if (!items.some((item: { id?: string }) => item.id === choice)) throw new Error(`Missing menu action ${choice}`)
      return choice
    })
  }, choice)
}

for (const type of ['terminal', 'browser', 'editor', 'canvas', 'agent', 'review', 'surface'] as const) {
  test(`${type}: real detach, palette, overview reveal and owner-routed close`, async () => {
    const image = path.join(directory, 'preview.svg')
    writeFileSync(image, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>')
    const id = await main.evaluate(({ type, image }) => window.__cateE2E!.createPanel(type, type === 'editor' ? image : undefined), { type, image })
    expect(id).toBeTruthy()
    const detached = await detach(id)
    await expect.poll(() => main.evaluate(id => window.__cateE2E!.panels().some(p => p.id === id), id)).toBe(false)
    await expect.poll(() => detached.evaluate(id => window.__cateE2E!.panels().some(p => p.id === id && p.type !== undefined), id)).toBe(true)
    await detached.keyboard.press(`${mod}+k`)
    await expect(detached.getByRole('dialog')).toBeVisible()
    await detached.keyboard.press('Escape')
    await main.evaluate(() => window.__cateE2E!.openNavigationView('workspaces'))
    // Match the transferred panel's actual report label, not a duplicated local record.
    const title = await detached.evaluate(id => window.__cateE2E!.panels().find(p => p.id === id)!.title, id)
    const target = main.locator(`button[title="${title} — in another window"]`)
    await expect(target).toHaveCount(1)
    await chooseNativeMenu('show')
    await target.dispatchEvent('contextmenu')
    await expect(detached.locator(`[data-tab-panel-id="${id}"]`)).toBeVisible()
    // Native confirmation choices only: the production owner close flow and IPC run unchanged.
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
    await chooseNativeMenu('close')
    await target.dispatchEvent('contextmenu')
    await expect(target).toHaveCount(0)
    await expect.poll(() => detached.isClosed()).toBe(true)
  })
}

for (const view of ['skills', 'usage', 'pullRequests'] as const) {
  test(`${view} requests from a detached window belong to main`, async () => {
    const id = await main.evaluate(() => window.__cateE2E!.createPanel('editor'))
    const detached = await detach(id)
    await detached.evaluate(view => window.__cateE2E!.openApplicationOverlay(view), view)
    const selector = view === 'skills' ? 'section[aria-label="Skills"]' : view === 'usage' ? '[aria-label="Usage overview"]' : '[aria-label="Pull requests"]'
    await expect(main.locator(selector)).toBeVisible()
    await expect(detached.locator(selector)).toHaveCount(0)
    await expect(detached.locator('[data-tab-panel-id]')).toBeVisible()
  })
}

test('overview close asks the detached editor owner; cancellation retains the row and content', async () => {
  const id = await main.evaluate(() => window.__cateE2E!.createPanel('editor'))
  const detached = await detach(id)
  await detached.locator('.monaco-editor textarea').first().focus()
  await detached.keyboard.type('unsaved owner content')
  await expect.poll(() => detached.evaluate(id => window.__cateE2E!.panels().find(p => p.id === id)?.isDirty, id)).toBe(true)
  const row = main.locator('button[title$=" — in another window"]').filter({ hasText: 'Untitled' })
  await expect(row).toHaveCount(1)
  await chooseNativeMenu('close')
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }) })
  await row.dispatchEvent('contextmenu')
  await expect(row).toBeVisible()
  expect(detached.isClosed()).toBe(false)
  await expect(detached.locator('.monaco-editor')).toContainText('unsaved owner content')
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await row.dispatchEvent('contextmenu')
  await expect(row).toHaveCount(0)
})
