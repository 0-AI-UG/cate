// Public-network browser smoke through the complete production path:
// real Cate PTY -> bundled cate CLI -> per-workspace CATE_API -> renderer
// browser driver -> main-owned browser session -> public HTTPS websites.

import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { closeApp, launchApp, seedTerminal } from './fixtures/electron-app'
import { fixtureEvaluate } from './fixtures/browser-control'

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

  const run = (code: string) => runCate(terminalNodeId, 'browser', 'run', code)
  const createdResult = JSON.parse(await runCate(terminalNodeId, 'browser', 'run',
    'var tab = await cua.createBrowserTab("https://httpbin.org/forms/post"); await nodeRepl.write({createdPanel:tab.panelId});', '--json')) as { content: Array<{ type: string; text?: string }> }
  const created = createdResult.content.filter((item) => item.type === 'text').map((item) => {
    try { return JSON.parse(item.text!) as { createdPanel?: string } } catch { return {} }
  }).find((item) => item.createdPanel)!
  expect(created.createdPanel).toMatch(/^[a-z0-9-]+$/i)
  await expect.poll(() => page.evaluate(
    (panelId) => window.__cateE2E!.nodes().some((node) => node.panelId === panelId), created.createdPanel!,
  ), { timeout: 15_000 }).toBe(true)

  // Resolve only IDs present in the observed accessibility tree. This helper
  // deliberately fails on ambiguity instead of guessing a page selector.
  await run(`var id = async function(name,role){
    var state=await tab.getAXState({emit:false,disableDiffing:true});
    var matches=state.elements.filter(e=>e.name.trim().replace(/:$/,"").trim()===name&&(!role||e.role===role));
    if(matches.length!==1)throw Error("Expected unique accessible target: "+name+"; observed "+JSON.stringify(state.elements.filter(e=>e.role===role).map(e=>e.name)));
    return matches[0].id;
  };`)
  await run(`await tab.setValue(await id("Customer name","textbox"),"Cate Terminal Test");
    await tab.setValue(await id("Telephone","textbox"),"+49 30 123456");
    await tab.setValue(await id("E-mail address","textbox"),"terminal-test@example.com");
    await tab.setChecked(await id("Large","radio"),true);
    await tab.setChecked(await id("Extra Cheese","checkbox"),true);
    await tab.setValue(await id("Delivery instructions","textbox"),"Leave at reception");
    await tab.click(await id("Submit order","button"));
    await tab.waitFor({text:"Cate Terminal Test"},{timeoutMs:30000});`)
  const responseBody = await run('await tab.getAXState({disableDiffing:true});')
  for (const text of ['Cate Terminal Test', 'terminal-test@example.com', 'Leave at reception', 'large', 'cheese']) expect(responseBody).toContain(text)

  await run('tab = await cua.createBrowserTab("https://example.com", {panelId:tab.panelId}); await tab.waitFor({text:"Example Domain"},{timeoutMs:30000});')
  const heading = await run('await tab.getAXState({disableDiffing:true});')
  expect(heading).toContain('https://example.com/')
  expect(heading).toContain('Example Domain')

  // Production document: CSP, client hints, deep AX tree, sticky chrome.
  await run('tab = await cua.createBrowserTab("https://en.wikipedia.org/wiki/Electron_(software_framework)", {panelId:tab.panelId}); await tab.waitFor({text:"Electron"},{timeoutMs:30000});')
  const wikipediaState = await run('await tab.getAXState({disableDiffing:true});')
  expect(wikipediaState).toContain('Electron')
  expect(wikipediaState).toContain('link')
  expect(wikipediaState.length).toBeGreaterThan(5_000)

  // Reactive application: hydration, keyboard submission, stateful controls.
  await run('tab = await cua.createBrowserTab("https://demo.playwright.dev/todomvc/", {panelId:tab.panelId});')
  await run(`var state=await tab.getAXState({emit:false,disableDiffing:true});
    var input=state.elements.filter(e=>e.role==="textbox");
    if(input.length!==1)throw Error("Expected one todo input");
    await tab.setValue(input[0].id,"Verify Cate public SPA control");
    await tab.pressKey("Return");
    await tab.waitFor({text:"Verify Cate public SPA control"},{timeoutMs:30000});`)
  expect(await run('await tab.getAXState({disableDiffing:true});')).toContain('Verify Cate public SPA control')
  // TodoMVC hides its native checkbox (opacity:0) and paints the control on
  // the label. Exercise visual input: only screenshot coordinates cross the
  // browser tool; the independent fixture oracle supplies/verifies the hit point.
  const todoBrowser = { workspaceId: '', panelId: created.createdPanel! }
  const point = await fixtureEvaluate(app, page, todoBrowser, `(() => {
    const box=document.querySelector('.todo-list .toggle').getBoundingClientRect();
    return [box.x+box.width/2,box.y+box.height/2];
  })()`) as [number, number]
  await run(`await tab.getAXStateAndScreenshot(); await tab.click(${JSON.stringify(point)}); await tab.waitFor({text:"Clear completed"});`)
  expect(await fixtureEvaluate(app, page, todoBrowser, "document.querySelector('.todo-list .toggle').checked")).toBe(true)
})
