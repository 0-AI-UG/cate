// =============================================================================
// GHSA-8769-jp52-985f, end to end in the real app.
//
// The unit tests mock the filesystem and the store. This one writes an actual
// hostile `.cate/workspace.json` to a real directory, points a workspace at it
// in a real Electron instance, and asserts that the user is asked before
// anything from that folder is opened — and that declining opens nothing.
//
// That covers the pieces mocks cannot: the preload bridge, the main-process
// trust store, and the real IPC round trip.
//
// The advisory's own PoC is the fixture, with the payload changed from launching
// Calculator to touching a marker file so the assertion is programmatic.
// =============================================================================

import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './fixtures/electron-app'
import type { ElectronApplication, Page } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let app: ElectronApplication
let page: Page
let repoDir: string
let markerPath: string

/** Write the advisory's PoC repo: a committed layout that restores an agent
 *  panel, plus an eager MCP server whose command touches a marker file. */
function writeHostileRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-ghsa-8769-'))
  fs.mkdirSync(path.join(dir, '.cate'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.pi'), { recursive: true })
  markerPath = path.join(dir, 'PWNED')

  fs.writeFileSync(path.join(dir, '.cate', 'workspace.json'), JSON.stringify({
    version: 1,
    name: 'Cate MCP PoC',
    color: '',
    panels: { 'agent-poc': { type: 'agent', title: 'Agent' } },
    dockState: {
      zones: {
        left: { position: 'left', visible: false, size: 0, layout: null },
        right: { position: 'right', visible: false, size: 0, layout: null },
        bottom: { position: 'bottom', visible: false, size: 0, layout: null },
        center: {
          position: 'center', visible: true, size: 0,
          layout: { type: 'tabs', id: 'agent-poc-tabs', panelIds: ['agent-poc'], activeIndex: 0 },
        },
      },
    },
  }, null, 2))

  fs.writeFileSync(path.join(dir, '.pi', 'mcp.json'), JSON.stringify({
    mcpServers: {
      'marker-poc': { command: '/usr/bin/touch', args: [markerPath], lifecycle: 'eager' },
    },
  }, null, 2))

  return dir
}

/** Point a fresh workspace at the hostile repo, the way the folder picker does.
 *  Does NOT await — the open blocks on the trust dialog by design. */
async function openHostileRepo(wsId: string): Promise<void> {
  await page.evaluate(async ({ dir, id }) => {
    window.__cateE2E!.addWorkspace('PoC', undefined, id)
    await window.__cateE2E!.selectWorkspace(id)
    // Deliberately not awaited: it doesn't resolve until the dialog is answered.
    void window.__cateE2E!.setWorkspaceRoot(dir)
  }, { dir: repoDir, id: wsId })
}

test.beforeEach(async () => {
  repoDir = writeHostileRepo()
  ;({ electronApp: app, mainWindow: page } = await launchApp())
})

test.afterEach(async () => {
  await closeApp(app)
  fs.rmSync(repoDir, { recursive: true, force: true })
})

test('opening an unknown project asks before anything is restored', async () => {
  await openHostileRepo('ghsa-poc-ws')

  await expect(page.locator('text=Do you trust this project?')).toBeVisible({ timeout: 5000 })
  // The safe action holds focus, so a stray Enter can't grant trust.
  await expect(page.locator('button:has-text("Don\'t open")')).toBeFocused()

  // The repo asked for an agent panel. Nothing is restored while the question
  // is still open.
  const panels = await page.evaluate(() => window.__cateE2E!.panelTypes('ghsa-poc-ws'))
  expect(panels).not.toContain('agent')
})

test('declining opens nothing', async () => {
  await openHostileRepo('ghsa-poc-ws2')
  await expect(page.locator('text=Do you trust this project?')).toBeVisible({ timeout: 5000 })

  await page.locator('button:has-text("Don\'t open")').click()
  await expect(page.locator('text=Do you trust this project?')).toBeHidden()
  await page.waitForTimeout(1500)

  // Declining is the end of it: nothing from the repo's layout is open.
  const panels = await page.evaluate(() => window.__cateE2E!.panelTypes('ghsa-poc-ws2'))
  expect(panels).not.toContain('agent')
})

test('the withheld payload never runs (backstop, cannot fail without a provider)', async () => {
  await openHostileRepo('ghsa-poc-ws3')
  await expect(page.locator('text=Do you trust this project?')).toBeVisible({ timeout: 5000 })
  await page.locator('button:has-text("Don\'t open")').click()
  await page.waitForTimeout(1500)

  // No agent panel ⇒ no pi ⇒ no MCP adapter ⇒ the eager server never spawns.
  expect(fs.existsSync(markerPath)).toBe(false)
})

// HONESTY NOTE: unlike the others, the marker assertion above also passes
// WITHOUT the fix. The e2e profile has no configured pi provider (advisory
// precondition 3), so pi never starts here and the marker is never touched
// either way. It is kept as a backstop, not as evidence — the dialog and
// no-panel assertions are what demonstrate the fix.

test('trusting opens the project for real', async () => {
  await openHostileRepo('ghsa-poc-ws4')
  await expect(page.locator('text=Do you trust this project?')).toBeVisible({ timeout: 5000 })

  await page.locator('button:has-text("Trust and open")').click()
  await expect(page.locator('text=Do you trust this project?')).toBeHidden()
  await page.waitForTimeout(1500)

  // Trust is the ONLY thing that changed: the same layout now restores in full,
  // agent panel included. There is no half-open state between the two.
  const panels = await page.evaluate(() => window.__cateE2E!.panelTypes('ghsa-poc-ws4'))
  expect(panels).toContain('agent')
})
