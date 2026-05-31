// E2E coverage for the cate-control agent feature — drives the real renderer
// dispatcher (window.__cateE2E.cateControl) exactly as an agent tool call would,
// then observes the live app. Uses the consolidated 4-tool surface
// (layout{op} / panel{op} / browser / terminal{op}). Focused on:
//   1. terminal commands actually run (panel open + terminal run)
//   2. markdown preview can be toggled (panel preview)
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './fixtures/electron-app'
import type { ElectronApplication, Page } from 'playwright'

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
})
test.afterEach(async () => closeApp(app))

async function cate(p: Page, action: string, params: Record<string, unknown>): Promise<any> {
  return p.evaluate(
    ({ action, params }) => window.__cateE2E!.cateControl(action, params),
    { action, params },
  )
}

test('terminal run executes the command in a live PTY', async () => {
  const res = await cate(page, 'terminal', { op: 'run', command: 'echo $((6*7))_CATEOK', newPanel: true })
  expect(res.ok).toBe(true)
  const panelId = res.result.panelId as string
  expect(panelId).toBeTruthy()
  // "42_CATEOK" appears only in the command OUTPUT (the echoed input line shows
  // the literal "echo $((6*7))_CATEOK"), so matching it proves the shell ran.
  await expect
    .poll(() => page.evaluate((pid) => window.__cateE2E!.terminalText(pid), panelId), {
      timeout: 15_000,
      intervals: [250],
    })
    .toContain('42_CATEOK')
})

test('panel open (terminal, command) runs the command', async () => {
  const res = await cate(page, 'panel', { op: 'open', type: 'terminal', target: { command: 'echo $((8*8))_CATEOPEN' } })
  expect(res.ok).toBe(true)
  const panelId = res.result.panelId as string
  await expect
    .poll(() => page.evaluate((pid) => window.__cateE2E!.terminalText(pid), panelId), {
      timeout: 15_000,
      intervals: [250],
    })
    .toContain('64_CATEOPEN')
})

test('panel preview toggles the editor into preview mode', async () => {
  const opened = await cate(page, 'panel', { op: 'open', type: 'editor', target: { path: 'CATE_NOTES.md' } })
  expect(opened.ok).toBe(true)
  const panelId = opened.result.panelId as string
  const nodeId = await page.evaluate(
    (pid) => window.__cateE2E!.nodes().find((n) => n.panelId === pid)?.id ?? null,
    panelId,
  )
  expect(nodeId).toBeTruthy()
  const nodeSel = `[data-node-id="${nodeId}"]`
  await page.waitForSelector(nodeSel)

  // Before: a markdown file shows the "Preview" toggle (source mode).
  await expect(page.locator(`${nodeSel} button:has-text("Preview")`)).toBeVisible()

  // Turn preview on through the tool.
  const pv = await cate(page, 'panel', { op: 'preview', panelId, preview: true })
  expect(pv.ok).toBe(true)

  // After: the toggle flips to "Source" — preview is now active.
  await expect(page.locator(`${nodeSel} button:has-text("Source")`)).toBeVisible()
})

test('panel preview rejects a non-existent panel', async () => {
  const res = await cate(page, 'panel', { op: 'preview', panelId: 'does-not-exist', preview: true })
  expect(res.ok).toBe(false)
})
