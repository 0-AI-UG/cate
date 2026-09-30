// Real Cate CLI E2E: launches Electron with a runtime install that carries the
// `cate` CLI (fixtures/runtime-install.ts), types commands into a real Cate
// terminal, and drives panels, terminals and a real browser panel webview
// through the runtime's `cate` API.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import http from 'node:http'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { closeApp, guestEvaluate, makeHome, makeProject, seedOnCanvas } from './fixtures/electron-app'
import { launchWithRuntime } from './fixtures/runtime-install'
import { cate, runCate as runCateIn, runInTerminal } from './fixtures/cate-terminal'

let app: ElectronApplication
let page: Page
let server: http.Server
let baseUrl = ''
let workspace = ''
let home = ''

const FORM_HTML = `<!doctype html>
<html>
  <head><title>Form Ready</title></head>
  <body style="min-height: 1200px">
    <h1>Cate CLI browser fixture</h1>
    <form id="form">
      <label for="query">Query</label>
      <input id="query" type="search" />
      <label for="password">Password</label>
      <input id="password" type="password" value="never-expose-me" />
      <button id="submit" type="submit">Submit query</button>
      <button id="click" type="button">Click me</button>
      <div id="status">Loading</div>
    </form>
    <script>
      document.querySelector('#click').addEventListener('click', () => {
        document.title = 'Clicked'
        setTimeout(() => { document.querySelector('#status').textContent = 'Saved' }, 100)
      })
      document.querySelector('#form').addEventListener('submit', (event) => {
        event.preventDefault()
        document.title = 'Submitted:' + document.querySelector('#query').value
      })
    </script>
  </body>
</html>`

test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(FORM_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/form`
})
test.afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })

test.beforeEach(async () => {
  home = makeHome()
  workspace = realpathSync(makeProject(home, { files: { 'cli-fixture.ts': 'export const e2e = true\n' } }))
  ;({ electronApp: app, mainWindow: page } = await launchWithRuntime({ home, workspace }))
  // Terminal input is the only CLI permission off by default.
  await page.evaluate(() => window.__cateE2E!.call('settings', 'set', { key: 'cliTerminalInputEnabled', value: true }))
})
test.afterEach(async () => closeApp(app, { home }))

test('the core cate CLI workflow works from a real Cate terminal', async () => {
  test.setTimeout(180_000)
  const control = (await seedOnCanvas(page, 'terminal', { x: 120, y: 120 })).panelId
  const runCate = (...args: string[]) => runCateIn(page, control, ...args)

  // Process and transport basics.
  expect(await runCate('--version')).toMatch(/^cate cli \d+$/)
  expect(await runCate('--help')).toContain('browser')
  expect(await runCate('version')).toMatch(/^\d+$/)
  expect(await runCate('panel', 'list')).toContain('terminal')

  // Editor and panel verbs.
  const editorId = await runCate('editor', 'open', `${path.join(workspace, 'cli-fixture.ts')}:1:8`)
  expect(editorId).toMatch(/^[a-z0-9-]{8}$/i)
  expect(await runCate('panel', 'list')).toContain('cli-fixture.ts')
  const browserId = await runCate('panel', 'create', 'browser')
  expect(await runCate('panel', 'list')).toContain(browserId)

  // A second real terminal proves terminal type/press/read, not just the
  // shell hosting this test's CLI process.
  const workerId = await runCate('panel', 'create', 'terminal')
  const worker = await expect.poll(() => page.evaluate((prefix) => window.__cateE2E!.panels().find((p) => p.id.startsWith(prefix))?.id ?? '', workerId), { timeout: 15_000 })
    .not.toBe('').then(() => page.evaluate((prefix) => window.__cateE2E!.panels().find((p) => p.id.startsWith(prefix))!.id, workerId))
  await expect.poll(() => page.evaluate((id) => window.__cateE2E!.terminalText(id).catch(() => ''), worker), { timeout: 30_000 }).toMatch(/\S/)
  const workerOutput = path.join(workspace, 'cli-worker.out')
  const workerCommand = process.platform === 'win32'
    ? 'Set-Content -NoNewline cli-worker.out CLI_TARGET_OK; Get-Content cli-worker.out'
    : 'printf CLI_TARGET_OK > cli-worker.out; cat cli-worker.out'
  await runCate('terminal', 'type', workerCommand, '--panel', workerId)
  await runCate('terminal', 'press', 'enter', '--panel', workerId)
  await expect.poll(() => existsSync(workerOutput) ? readFileSync(workerOutput, 'utf8') : '', { timeout: 10_000 }).toBe('CLI_TARGET_OK')
  expect(await runCate('terminal', 'read', '--panel', workerId)).toContain('CLI_TARGET_OK')

  // Close keeps the list consistent for several panel types.
  for (const id of [workerId, browserId, editorId]) await runCate('panel', 'close', id)
  const finalPanels = await runCate('panel', 'list')
  for (const id of [workerId, browserId, editorId]) expect(finalPanels).not.toContain(id)
})

test('cate browser run drives a real browser panel webview', async () => {
  test.setTimeout(180_000)
  const control = (await seedOnCanvas(page, 'terminal', { x: 120, y: 120 })).panelId
  const runCate = (...args: string[]) => runCateIn(page, control, ...args)
  const runBrowser = (code: string) => runCate('browser', 'run', code)
  const browserId = await runCate('panel', 'create', 'browser')
  const created = JSON.parse(await runCate('browser', 'run', `var tab = await cua.createBrowserTab(${JSON.stringify(baseUrl)}, {panelId:${JSON.stringify(browserId)}}); await nodeRepl.write({testBinding:{panelId:tab.panelId,tabId:tab.tabId}});`, '--json')) as { content: { type: string; text?: string }[] }
  expect(created.content.some((item) => item.text?.includes('testBinding'))).toBe(true)
  const oracle = (expression: string) => guestEvaluate(app, baseUrl, expression)

  const state = await runBrowser('await tab.getAXStateAndScreenshot({disableDiffing:true});')
  expect(state).toContain('Form Ready')
  expect(state).toContain('••••••••')
  expect(state).not.toContain('never-expose-me')
  await runBrowser(`var id = async function(name,role){
    var state=await tab.getAXState({disableDiffing:true,emit:false});
    var matches=state.elements.filter(e=>e.name.trim()===name&&(!role||e.role===role));
    if(matches.length!==1)throw Error("Expected unique accessible target: "+name);
    return matches[0].id;
  }; var query = await id("Query","searchbox"); var click = await id("Click me","button");`)
  await runBrowser('await tab.setValue(query,"hello"); await tab.typeText(" cate");')
  expect(await oracle('document.querySelector("#query").value')).toBe('hello cate')
  await runBrowser('await tab.click(click); await tab.waitFor({text:"Saved"},{timeoutMs:3000});')
  await runBrowser('await tab.selectText(query,"hello cate",{selectionType:"cursor_after"}); await tab.pressKey("Return");')
  expect(await oracle('document.title')).toBe('Submitted:hello cate')

  const screenshots = await runBrowser('await tab.getAXStateAndScreenshot();')
  const imagePath = screenshots.split('\n').find((line) => line.trim().endsWith('.png'))?.trim().replace(/^Screenshot: /, '')
  expect(imagePath && existsSync(imagePath)).toBeTruthy()
  expect(readFileSync(imagePath!).subarray(1, 4).toString()).toBe('PNG')

  // Arbitrary page evaluation is not offered, and rejection keeps the session usable.
  const noDom = await runInTerminal(page, control, cate('browser', 'run', 'await nodeRepl.write({pageEvaluation:typeof tab.evaluate,node:typeof require});'))
  expect(noDom.output).toContain('undefined')
  await runCate('browser', 'reset')
  expect(await runBrowser('await nodeRepl.write(typeof tab);')).toContain('undefined')
})
