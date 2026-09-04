// Public-network browser smoke through the complete production path:
// real Cate PTY -> bundled cate CLI -> per-workspace CATE_API -> renderer
// browser driver -> main-owned browser session -> public HTTPS websites.

import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { closeApp, launchApp, seedTerminal } from './fixtures/electron-app'

let app: ElectronApplication
let page: Page
let workspace = ''
let commandSequence = 0

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `'${value.replace(/'/g, "''")}'`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function runCate(nodeId: string, ...args: string[]): Promise<string> {
  const sequence = ++commandSequence
  const begin = `__CATE_PUBLIC_BEGIN_${sequence}__`
  const end = `__CATE_PUBLIC_END_${sequence}__`
  const command = `cate ${args.map(shellQuote).join(' ')}`
  const wrapped = process.platform === 'win32'
    ? `Write-Output "${begin}"; ${command}; $cateStatus=$LASTEXITCODE; Write-Output "${end}:$cateStatus"\r`
    : `printf '\\n${begin}\\n'; ${command}; cate_status=$?; printf '\\n${end}:%s\\n' "$cate_status"\r`

  expect(await page.evaluate(
    ({ id, data }) => window.__cateE2E!.writeTerminal(id, data),
    { id: nodeId, data: wrapped },
  )).toBe(true)
  await expect.poll(
    () => page.evaluate(
      ({ id, marker }) => new RegExp(`${marker}:\\d+`).test(window.__cateE2E!.terminalText(id) ?? ''),
      { id: nodeId, marker: end },
    ),
    { timeout: 45_000 },
  ).toBe(true)

  const screen = await page.evaluate((id) => window.__cateE2E!.terminalText(id), nodeId)
  const endMatch = screen?.match(new RegExp(`${end}:(\\d+)`))
  expect(endMatch, screen ?? 'terminal unavailable').not.toBeNull()
  const endAt = screen!.lastIndexOf(endMatch![0])
  const beginAt = screen!.lastIndexOf(begin, endAt)
  const output = screen!.slice(beginAt + begin.length, endAt).trim()
  expect(Number(endMatch![1]), `${args.join(' ')}\n${output}`).toBe(0)
  return output
}

test.beforeEach(async () => {
  workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'cate-public-e2e-')))
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  const opened = page.evaluate((root) => window.__cateE2E!.setWorkspaceRoot(root), workspace)
  await page.getByRole('button', { name: 'Trust and open' }).click()
  expect(await opened).toBe(true)
  await page.evaluate(() => Promise.all([
    window.electronAPI.settingsSet('cliTerminalInputEnabled', true),
    window.electronAPI.settingsSet('cliBrowserControlEnabled', true),
  ]))
})

test.afterEach(async () => {
  await closeApp(app)
  rmSync(workspace, { recursive: true, force: true })
})

test('@public-network controls public sites from a real Cate terminal', async () => {
  test.setTimeout(180_000)
  const terminalNodeId = await seedTerminal(page, { x: 100, y: 100 })
  await expect.poll(
    () => page.evaluate((id) => window.__cateE2E!.terminalPtyId(id), terminalNodeId),
    { timeout: 60_000 },
  ).not.toBeNull()

  const created = JSON.parse(await runCate(
    terminalNodeId,
    'browser', 'new-panel', 'https://httpbin.org/forms/post', '--json',
  )) as { panelId: string }
  expect(created.panelId).toMatch(/^[a-z0-9-]+$/i)
  await expect.poll(
    () => page.evaluate(
      (panelId) => window.__cateE2E!.nodes().some((node) => node.panelId === panelId),
      created.panelId,
    ),
    { timeout: 15_000 },
  ).toBe(true)

  const panel = ['--panel', created.panelId]
  await runCate(terminalNodeId, 'browser', 'wait', '[name="custname"]', '--state', 'visible', '--timeout', '30000', ...panel)
  await runCate(terminalNodeId, 'browser', 'fill', '[name="custname"]', 'Cate Terminal Test', ...panel)
  await runCate(terminalNodeId, 'browser', 'fill', '[name="custtel"]', '+49 30 123456', ...panel)
  await runCate(terminalNodeId, 'browser', 'fill', '[name="custemail"]', 'terminal-test@example.com', ...panel)
  await runCate(terminalNodeId, 'browser', 'check', '[name="size"][value="large"]', ...panel)
  await runCate(terminalNodeId, 'browser', 'check', '[name="topping"][value="cheese"]', ...panel)
  await runCate(terminalNodeId, 'browser', 'fill', '[name="comments"]', 'Leave at reception', ...panel)
  await runCate(terminalNodeId, 'browser', 'click', 'form button', ...panel)
  await runCate(terminalNodeId, 'browser', 'wait', '--text', 'Cate Terminal Test', '--timeout', '30000', ...panel)

  const responseBody = await runCate(terminalNodeId, 'browser', 'get', 'text', 'body', ...panel)
  expect(responseBody).toContain('Cate Terminal Test')
  expect(responseBody).toContain('terminal-test@example.com')
  expect(responseBody).toContain('Leave at reception')
  expect(responseBody).toContain('large')
  expect(responseBody).toContain('cheese')

  await runCate(terminalNodeId, 'browser', 'new-tab', 'https://example.com', ...panel)
  await runCate(terminalNodeId, 'browser', 'wait', 'h1', '--state', 'visible', '--timeout', '30000', ...panel)
  const heading = JSON.parse(await runCate(
    terminalNodeId, 'browser', 'get', 'text', 'h1', ...panel,
  )) as { origin: string; text: string }
  expect(heading).toMatchObject({ origin: 'https://example.com/', text: 'Example Domain' })

  // A large production document exercises real CSP, client hints, a deep
  // accessibility tree, sticky chrome, and in-page navigation.
  await runCate(terminalNodeId, 'browser', 'new-tab', 'https://en.wikipedia.org/wiki/Electron_(software_framework)', ...panel)
  await runCate(terminalNodeId, 'browser', 'wait', '#firstHeading', '--state', 'visible', '--timeout', '30000', ...panel)
  expect(await runCate(terminalNodeId, 'browser', 'get', 'text', '#firstHeading', ...panel)).toContain('Electron')
  const wikipediaSnapshot = await runCate(terminalNodeId, 'browser', 'snapshot', '-i', ...panel)
  expect(wikipediaSnapshot).toContain('link')
  expect(wikipediaSnapshot.length).toBeGreaterThan(5_000)

  // A real client-rendered application catches compatibility issues that a
  // static page and server-rendered form cannot: hydration, reactive updates,
  // content created after load, keyboard submission, and stateful controls.
  await runCate(terminalNodeId, 'browser', 'new-tab', 'https://demo.playwright.dev/todomvc/', ...panel)
  await runCate(terminalNodeId, 'browser', 'wait', '.new-todo', '--state', 'visible', '--timeout', '30000', ...panel)
  await runCate(terminalNodeId, 'browser', 'fill', '.new-todo', 'Verify Cate public SPA control', ...panel)
  await runCate(terminalNodeId, 'browser', 'focus', '.new-todo', ...panel)
  await runCate(terminalNodeId, 'browser', 'press', 'Enter', ...panel)
  await runCate(terminalNodeId, 'browser', 'wait', '--text', 'Verify Cate public SPA control', '--timeout', '30000', ...panel)
  expect(await runCate(terminalNodeId, 'browser', 'get', 'text', '.todo-list label', ...panel))
    .toContain('Verify Cate public SPA control')
  await runCate(terminalNodeId, 'browser', 'check', '.todo-list .toggle', ...panel)
  expect(JSON.parse(await runCate(terminalNodeId, 'browser', 'is', 'checked', '.todo-list .toggle', ...panel)))
    .toMatchObject({ checked: true })
})
