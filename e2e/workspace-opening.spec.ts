// Opening a workspace draws it once: until its document is in and its trust
// is settled, its place shows the opening surface (and the trust question in
// it), never an empty layout or the welcome page that the real one replaces.

import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { addCanvas, closeApp, launchApp, makeHome, makeProject } from './fixtures/electron-app'

const EMPTY_DOCK = '[data-empty-workspace-dock]'
const WELCOME = '[data-onboarding="welcome-actions"]'
const OPENING = '[data-workspace-opening]'

/** Records every watched selector that was ever in the DOM, in order. */
async function watch(page: Page): Promise<void> {
  await page.evaluate(({ selectors }) => {
    const w = window as unknown as { __seen: string[] }
    w.__seen = []
    const record = () => {
      for (const selector of selectors) if (!w.__seen.includes(selector) && document.querySelector(selector)) w.__seen.push(selector)
    }
    new MutationObserver(record).observe(document, { subtree: true, childList: true, attributes: true })
    record()
  }, { selectors: [EMPTY_DOCK, WELCOME, OPENING, '[data-canvas-container]'] })
}

const seen = (page: Page) => page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)

test('a restart shows the last workspace without an empty layout or the welcome page first', async () => {
  const home = makeHome()
  const userDataDir = path.join(home, 'ud')
  const first = await launchApp({ home, userDataDir })
  await closeApp(first.electronApp, { home, keepRuntimes: true })
  const second = await launchApp({ home, userDataDir, workspace: false, onWindow: watch })
  try {
    await second.mainWindow.waitForSelector('[data-canvas-container]', { timeout: 30_000 })
    const order = await seen(second.mainWindow)
    // Watching from before the first frame: the opening surface came first.
    expect(order[0]).toBe(OPENING)
    expect(order).not.toContain(EMPTY_DOCK)
    expect(order).not.toContain(WELCOME)
    expect(order.at(-1)).toBe('[data-canvas-container]')
  } finally {
    await closeApp(second.electronApp, { home })
  }
})

test('a new folder asks about trust in its place, then shows', async () => {
  const { electronApp, mainWindow: page, home } = await launchApp()
  try {
    await addCanvas(page)
    await watch(page)
    const project = makeProject(home, { name: 'second' })
    const opened = page.evaluate((root) => window.__cateE2E!.addWorkspace(undefined, root), project)
    const trust = page.locator(OPENING).getByRole('button', { name: 'Trust and open' })
    await expect(trust).toBeVisible({ timeout: 30_000 })
    // No modal on top, and nothing of the workspace drawn before the answer.
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(0)
    expect(await seen(page)).not.toContain(EMPTY_DOCK)
    await trust.click()
    const id = await opened
    await page.waitForFunction((ws) => !!window.__cateE2E!.document(ws), id, { timeout: 30_000 })
    // An empty project: its chooser is the real content now.
    await expect(page.locator(EMPTY_DOCK)).toBeVisible()
    await expect(page.locator(OPENING)).toHaveCount(0)
  } finally {
    await closeApp(electronApp)
  }
})
