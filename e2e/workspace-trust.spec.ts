// =============================================================================
// GHSA-8769-jp52-985f, end to end in the real app.
//
// The unit and integration tests mock the filesystem and the store. This one
// writes an actual hostile `.cate/workspace.json` to a real directory, opens it
// as a workspace in a real Electron instance, and asserts that the agent panel
// the repo asked for never materializes. That covers the pieces mocks cannot:
// the preload bridge, the main-process trust store, and the real IPC round trip.
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

test.beforeEach(async () => {
  repoDir = writeHostileRepo()
  ;({ electronApp: app, mainWindow: page } = await launchApp())
})

test.afterEach(async () => {
  await closeApp(app)
  fs.rmSync(repoDir, { recursive: true, force: true })
})

test('opening a hostile repo does not restore its agent panel', async () => {
  const panels = await page.evaluate(async (dir) => {
    const id = window.__cateE2E!.addWorkspace('PoC', dir, 'ghsa-poc-ws')
    await window.__cateE2E!.selectWorkspace(id)
    // Let the async hydrate-on-open settle.
    await new Promise((r) => setTimeout(r, 1500))
    return window.__cateE2E!.panelTypes(id)
  }, repoDir)

  // The repo asked for an agent panel. It must not be there.
  expect(panels).not.toContain('agent')
})

// HONESTY NOTE: unlike the other two, this test also passes WITHOUT the fix.
// The e2e profile has no configured pi provider (advisory precondition 3), so pi
// never starts here and the marker is never touched either way. Verified by
// reverting the gate: the other two specs fail, this one still passes.
//
// It is kept as a backstop, not as evidence. If the harness ever gains a
// provider, this becomes the real end-to-end assertion. Do not cite it as proof
// that the payload is blocked; the two specs around it are what demonstrate that.
test('the withheld payload never runs (backstop, cannot fail without a provider)', async () => {
  await page.evaluate(async (dir) => {
    const id = window.__cateE2E!.addWorkspace('PoC', dir, 'ghsa-poc-ws2')
    await window.__cateE2E!.selectWorkspace(id)
    await new Promise((r) => setTimeout(r, 1500))
  }, repoDir)

  // No agent panel ⇒ no pi ⇒ no MCP adapter ⇒ the eager server never spawns.
  expect(fs.existsSync(markerPath)).toBe(false)
})

test('the user is told what was withheld', async () => {
  await page.evaluate(async (dir) => {
    const id = window.__cateE2E!.addWorkspace('PoC', dir, 'ghsa-poc-ws3')
    await window.__cateE2E!.selectWorkspace(id)
    await new Promise((r) => setTimeout(r, 1500))
  }, repoDir)

  // Silently dropping the panel would leave the user confused about why their
  // layout is wrong, so the prompt is part of the fix, not decoration.
  await expect(page.locator('text=Do you trust this project?')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('text=1 Agent panel')).toBeVisible()
  // The safe action holds focus, so a stray Enter can't grant trust.
  await expect(page.locator('button:has-text("Open restricted")')).toBeFocused()
})

test('dismissing the prompt leaves the project untrusted', async () => {
  await page.evaluate(async (dir) => {
    const id = window.__cateE2E!.addWorkspace('PoC', dir, 'ghsa-poc-ws4')
    await window.__cateE2E!.selectWorkspace(id)
    await new Promise((r) => setTimeout(r, 1500))
  }, repoDir)

  await page.locator('button:has-text("Open restricted")').click()

  // Prompt gone, but nothing was trusted and nothing was restored: dismissing
  // must never be a quiet yes.
  await expect(page.locator('text=Do you trust this project?')).toBeHidden()
  const panels = await page.evaluate(() => window.__cateE2E!.panelTypes('ghsa-poc-ws4'))
  expect(panels).not.toContain('agent')
})
