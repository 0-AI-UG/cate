// E2E coverage for the cate-control agent feature - drives the real renderer
// dispatcher (window.__cateE2E.cateControl) exactly as an agent tool call would,
// then observes the live app. Uses the lean, titles-only 4-tool surface
// (layout / panel{open,close,move} / browser / terminal{run,read}). Focused on:
//   1. terminal commands actually run (panel open + terminal run)
//   2. opening an editor straight into markdown preview
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

// cate tools report panel TITLES; resolve to a panelId for the harness reads.
async function panelId(p: Page, title: string): Promise<string | null> {
  return p.evaluate((t) => window.__cateE2E!.panelIdByTitle(t), title)
}

test('terminal run executes the command in a live PTY', async () => {
  const res = await cate(page, 'terminal', { op: 'run', command: 'echo $((6*7))_CATEOK', newPanel: true })
  expect(res.ok).toBe(true)
  const title = res.result.terminal as string
  expect(title).toBeTruthy()
  // "42_CATEOK" appears only in the command OUTPUT (the echoed input line shows
  // the literal "echo $((6*7))_CATEOK"), so matching it proves the shell ran.
  await expect
    .poll(async () => {
      const pid = await panelId(page, title)
      return pid ? page.evaluate((p) => window.__cateE2E!.terminalText(p), pid) : ''
    }, { timeout: 15_000, intervals: [250] })
    .toContain('42_CATEOK')
})

test('panel open (terminal, command) runs the command', async () => {
  const res = await cate(page, 'panel', { op: 'open', type: 'terminal', target: { command: 'echo $((8*8))_CATEOPEN' } })
  expect(res.ok).toBe(true)
  const title = res.result.title as string
  await expect
    .poll(async () => {
      const pid = await panelId(page, title)
      return pid ? page.evaluate((p) => window.__cateE2E!.terminalText(p), pid) : ''
    }, { timeout: 15_000, intervals: [250] })
    .toContain('64_CATEOPEN')
})

test('panel open with target.preview enters markdown preview', async () => {
  const opened = await cate(page, 'panel', { op: 'open', type: 'editor', target: { path: 'CATE_NOTES.md', preview: true } })
  expect(opened.ok).toBe(true)
  const pid = await panelId(page, opened.result.title as string)
  expect(pid).toBeTruthy()
  const nodeId = await page.evaluate(
    (p) => window.__cateE2E!.nodes().find((n) => n.panelId === p)?.id ?? null,
    pid,
  )
  expect(nodeId).toBeTruthy()
  const nodeSel = `[data-node-id="${nodeId}"]`
  await page.waitForSelector(nodeSel)
  // Preview active → the toggle reads "Source" (click to go back to source).
  await expect(page.locator(`${nodeSel} button:has-text("Source")`)).toBeVisible()
})

test('closing a non-existent panel title errors', async () => {
  const res = await cate(page, 'panel', { op: 'close', panel: 'does-not-exist' })
  expect(res.ok).toBe(false)
})
