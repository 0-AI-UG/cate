// Public-network browser smoke through the complete production path:
// real Cate PTY -> bundled cate CLI -> per-workspace CATE_API -> renderer
// browser driver -> main-owned browser session -> public HTTPS websites.

import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp, seedOnCanvas } from './fixtures/electron-app'
import { fixtureEvaluate } from './fixtures/browser-control'

let app: ElectronApplication
let page: Page
let commandSequence = 0

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `'${value.replace(/'/g, "''")}'`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function runCate(panelId: string, ...args: string[]): Promise<string> {
  const sequence = ++commandSequence
  const begin = `__CATE_PUBLIC_BEGIN_${sequence}__`
  const end = `__CATE_PUBLIC_END_${sequence}__`
  const command = `cate ${args.map(shellQuote).join(' ')}`
  const wrapped = process.platform === 'win32'
    ? `Write-Output "${begin}"; ${command}; $cateStatus=$LASTEXITCODE; Write-Output "${end}:$cateStatus"\r`
    : `printf '\\n${begin}\\n'; ${command}; cate_status=$?; printf '\\n${end}:%s\\n' "$cate_status"\r`

  await page.evaluate(({ id, data }) => window.__cateE2E!.writeTerminal(id, data), { id: panelId, data: wrapped })
  await expect.poll(
    () => page.evaluate(
      async ({ id, marker }) => new RegExp(`${marker}:\\d+`).test(await window.__cateE2E!.terminalText(id) ?? ''),
      { id: panelId, marker: end },
    ),
    { timeout: 45_000 },
  ).toBe(true)

  const screen = await page.evaluate((id) => window.__cateE2E!.terminalText(id), panelId)
  const endMatch = screen?.match(new RegExp(`${end}:(\\d+)`))
  expect(endMatch, screen ?? 'terminal unavailable').not.toBeNull()
  const endAt = screen!.lastIndexOf(endMatch![0])
  const beginAt = screen!.lastIndexOf(begin, endAt)
  const output = screen!.slice(beginAt + begin.length, endAt).trim()
  expect(Number(endMatch![1]), `${args.join(' ')}\n${output}`).toBe(0)
  return output
}

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  await page.evaluate(async () => {
    await window.__cateE2E!.call('settings', 'set', { key: 'cliTerminalInputEnabled', value: true })
    await window.__cateE2E!.call('settings', 'set', { key: 'cliBrowserControlEnabled', value: true })
  })
})

test.afterEach(async () => {
  await closeApp(app)
})

// Needs the `cate` CLI on the terminal's PATH (the installed runtime's
// `cate/bin`; a dev launch with CATE_RUNTIME_BUNDLE has none).
test.fixme('@public-network controls public sites from a real Cate terminal', async () => {
  test.setTimeout(180_000)
  const { panelId: terminalNodeId } = await seedOnCanvas(page, 'terminal', { x: 100, y: 100 })
  await expect.poll(
    () => page.evaluate((id) => window.__cateE2E!.sessionSnapshot(id).then((s) => (s as { ptyId?: string } | null)?.ptyId ?? null), terminalNodeId),
    { timeout: 60_000 },
  ).not.toBeNull()

  const browser = (...args: string[]) => runCate(terminalNodeId, 'browser', ...args, '--panel', createdPanel)
  const shortPanelId = await runCate(terminalNodeId, 'panel', 'create', 'browser', 'https://httpbin.org/forms/post')
  const createdPanel = await expect.poll(() => page.evaluate(
    (prefix) => window.__cateE2E!.panels().find((panel) => panel.id.startsWith(prefix))?.id ?? '', shortPanelId,
  ), { timeout: 15_000 }).not.toBe('').then(() => page.evaluate(
    (prefix) => window.__cateE2E!.panels().find((panel) => panel.id.startsWith(prefix))!.id, shortPanelId,
  ))
  await browser('snapshot')

  // Elements by the role and name the snapshot shows; an ambiguous name fails
  // instead of guessing.
  await browser('fill', '--role', 'textbox', '--name', 'Customer name', 'Cate Terminal Test')
  await browser('fill', '--role', 'textbox', '--name', 'Telephone', '+49 30 123456')
  await browser('fill', '--role', 'textbox', '--name', 'E-mail address', 'terminal-test@example.com')
  await browser('check', '--role', 'radio', '--name', 'Large')
  await browser('check', '--role', 'checkbox', '--name', 'Extra Cheese')
  await browser('fill', '--role', 'textbox', '--name', 'Delivery instructions', 'Leave at reception')
  await browser('click', '--role', 'button', '--name', 'Submit order')
  await browser('wait', '--text', 'Cate Terminal Test', '--timeout', '30000')
  const responseBody = await browser('snapshot')
  for (const text of ['Cate Terminal Test', 'terminal-test@example.com', 'Leave at reception', 'large', 'cheese']) expect(responseBody).toContain(text)

  await browser('tab', 'new', 'https://example.com')
  await browser('wait', '--text', 'Example Domain', '--timeout', '30000')
  const heading = await browser('snapshot')
  expect(heading).toContain('https://example.com/')
  expect(heading).toContain('Example Domain')

  // Production document: CSP, client hints, deep AX tree, sticky chrome.
  await browser('tab', 'new', 'https://en.wikipedia.org/wiki/Electron_(software_framework)')
  await browser('wait', '--text', 'Electron', '--timeout', '30000')
  const wikipediaState = await browser('snapshot')
  expect(wikipediaState).toContain('Electron')
  expect(wikipediaState).toContain('link')
  expect(wikipediaState.length).toBeGreaterThan(5_000)

  // Reactive application: hydration, keyboard submission, stateful controls.
  await browser('tab', 'new', 'https://demo.playwright.dev/todomvc/')
  await browser('fill', '--role', 'textbox', 'Verify Cate public SPA control')
  await browser('press', 'Enter')
  await browser('wait', '--text', 'Verify Cate public SPA control', '--timeout', '30000')
  expect(await browser('snapshot')).toContain('Verify Cate public SPA control')
  // TodoMVC hides its native checkbox (opacity:0) and paints the control on
  // the label. Exercise visual input: only screenshot coordinates cross the
  // browser tool; the independent fixture oracle supplies/verifies the hit point.
  const todoBrowser = { workspaceId: '', panelId: createdPanel }
  const point = await fixtureEvaluate(app, page, todoBrowser, `(() => {
    const box=document.querySelector('.todo-list .toggle').getBoundingClientRect();
    return [box.x+box.width/2,box.y+box.height/2];
  })()`) as [number, number]
  await browser('screenshot')
  await browser('click', JSON.stringify(point))
  await browser('wait', '--text', 'Clear completed')
  await browser('tab', 'close', '--mine')
  expect(await fixtureEvaluate(app, page, todoBrowser, "document.querySelector('.todo-list .toggle').checked")).toBe(true)
})
