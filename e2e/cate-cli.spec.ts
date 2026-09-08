// Real Cate CLI E2E. Unlike src/cli/cate.integration.test.ts (scripted HTTP),
// this launches Electron, provisions Cate's runtime, types commands into a real
// Cate terminal, and drives a real persistent BrowserPanel webview through CATE_API.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import http from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { closeApp, launchApp, seedTerminal } from './fixtures/electron-app'
import { fixtureEvaluate } from './fixtures/browser-control'

let app: ElectronApplication
let page: Page
let server: http.Server
let baseUrl = ''
let workspace = ''

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
      <button id="semantic" type="button">Semantic action</button>
      <button id="double" type="button">Double action</button>
      <button id="hover" type="button">Hover action</button>
      <label><input id="option" type="checkbox" checked /> Optional setting</label>
      <label for="size">Size</label>
      <select id="size"><option value="small">Small</option><option value="large">Large</option></select>
      <div id="editor" role="textbox" aria-label="Editor" contenteditable="true">Draft</div>
      <button id="disabled" type="button" disabled>Disabled action</button>
      <div id="hidden" style="display:none">Hidden content</div>
      <div id="status">Loading</div>
      <div id="bottom" style="margin-top:1000px">Bottom marker</div>
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
      document.querySelector('#semantic').addEventListener('click', () => {
        document.body.dataset.semantic = 'clicked'
      })
      document.querySelector('#double').addEventListener('dblclick', () => {
        document.body.dataset.double = 'received'
      })
      document.querySelector('#hover').addEventListener('mouseenter', () => {
        document.body.dataset.hover = 'received'
      })
      window.addEventListener('mousemove', (event) => {
        document.body.dataset.mouse = event.clientX + ',' + event.clientY
      })
    </script>
  </body>
</html>`

function startFixtureServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(FORM_HTML)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      baseUrl = `http://127.0.0.1:${port}/form`
      resolve()
    })
  })
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `'${value.replace(/'/g, "''")}'`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function cate(...args: string[]): string {
  return `cate ${args.map(shellQuote).join(' ')}`
}

let commandSequence = 0

async function runInCateTerminal(
  nodeId: string,
  command: string,
  timeout = 20_000,
): Promise<{ code: number; output: string }> {
  const sequence = ++commandSequence
  const begin = `__CATE_BEGIN_${sequence}__`
  const end = `__CATE_END_${sequence}__`
  const wrapped = process.platform === 'win32'
    ? `Write-Output ("__CATE_{0}_${sequence}__" -f "BEGIN"); ${command}; $cateStatus=$LASTEXITCODE; Write-Output ("__CATE_{0}_${sequence}__:{1}" -f "END",$cateStatus)\r`
    : `printf '\\n__CATE_%s_${sequence}__\\n' BEGIN; ${command}; cate_status=$?; printf '\\n__CATE_%s_${sequence}__:%s\\n' END "$cate_status"\r`

  const accepted = await page.evaluate(
    ({ id, data }) => window.__cateE2E!.writeTerminal(id, data),
    { id: nodeId, data: wrapped },
  )
  expect(accepted).toBe(true)

  await expect.poll(
    () => page.evaluate((id) => window.__cateE2E!.terminalText(id), nodeId),
    { timeout },
  ).toContain(`${end}:`)

  const screen = await page.evaluate((id) => window.__cateE2E!.terminalText(id), nodeId)
  const endMatch = screen?.match(new RegExp(`${end}:(\\d+)`))
  expect(endMatch, screen ?? 'terminal unavailable').not.toBeNull()
  const endAt = screen!.lastIndexOf(endMatch![0])
  const beginAt = screen!.lastIndexOf(begin, endAt)
  expect(beginAt, screen ?? '').toBeGreaterThanOrEqual(0)
  return {
    code: Number(endMatch![1]),
    output: screen!.slice(beginAt + begin.length, endAt).trim(),
  }
}

async function runCate(nodeId: string, ...args: string[]): Promise<string> {
  const result = await runInCateTerminal(nodeId, cate(...args))
  expect(result.code, `${args.join(' ')}\n${result.output}`).toBe(0)
  return result.output
}

async function nodeForPanel(shortPanelId: string): Promise<string> {
  return expect.poll(
    async () => page.evaluate(
      (prefix) => window.__cateE2E!.nodes().find((node) => node.panelId.startsWith(prefix))?.id ?? '',
      shortPanelId,
    ),
    { timeout: 15_000 },
  ).not.toBe('').then(async () => page.evaluate(
    (prefix) => window.__cateE2E!.nodes().find((node) => node.panelId.startsWith(prefix))!.id,
    shortPanelId,
  ))
}

test.beforeAll(async () => {
  await startFixtureServer()
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test.beforeEach(async () => {
  // Match workspaceManager's canonical root (`/private/var/...` on macOS;
  // tmpdir() itself may spell the same directory through the `/var` symlink).
  workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'cate-cli-e2e-')))
  writeFileSync(path.join(workspace, 'cli-fixture.ts'), 'export const e2e = true\n')
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  const openWorkspace = page.evaluate(
    (root) => window.__cateE2E!.setWorkspaceRoot(root),
    workspace,
  )
  await page.getByRole('button', { name: 'Trust and open' }).click()
  expect(await openWorkspace).toBe(true)
  // Terminal input is the only CLI permission disabled by default. Enable it
  // through the real settings IPC so terminal type/press can be exercised.
  await page.evaluate(() => window.electronAPI.settingsSet('cliTerminalInputEnabled', true))
})

test.afterEach(async () => {
  await closeApp(app)
  rmSync(workspace, { recursive: true, force: true })
})

test('the core cate CLI workflow works from a real Cate terminal', async () => {
  test.setTimeout(180_000)
  const controlNode = await seedTerminal(page, { x: 120, y: 120 })
  await expect.poll(
    () => page.evaluate((id) => window.__cateE2E!.terminalPtyId(id), controlNode),
    { timeout: 60_000 },
  ).not.toBeNull()

  // Process/transport basics.
  expect(await runCate(controlNode, '--version')).toMatch(/^cate cli \d+$/)
  expect(await runCate(controlNode, '--help')).toContain('cate browser run <JavaScript>')
  expect(await runCate(controlNode, 'version')).toBe('8')
  expect(await runCate(controlNode, 'panel', 'list')).toContain('terminal')

  // Editor + panel verbs.
  const editorId = await runCate(controlNode, 'editor', 'open', `${path.join(workspace, 'cli-fixture.ts')}:1:8`)
  expect(editorId).toMatch(/^[a-z0-9-]{8}$/i)
  expect(await runCate(controlNode, 'panel', 'list')).toContain('cli-fixture.ts')

  // Browser code runs in one persistent session through the real terminal,
  // CLI, HTTP transport, renderer, and target-bound runtime.
  const runBrowser = (code: string) => runCate(controlNode, 'browser', 'run', code)
  const createBinding = async (code: string) => {
    const result = JSON.parse(await runCate(controlNode, 'browser', 'run', code, '--json')) as {
      content: Array<{ type: string; text?: string }>
    }
    const binding = result.content.filter((item) => item.type === 'text').map((item) => {
      try { return JSON.parse(item.text!) as { testBinding?: { panelId: string; tabId: string } } } catch { return {} }
    }).find((item) => item.testBinding)?.testBinding
    expect(binding).toBeTruthy()
    return binding!
  }
  const freshDataOne = `data:text/html,${encodeURIComponent('<title>Fresh One</title>')}`
  const freshDataTwo = `data:text/html,${encodeURIComponent('<title>Fresh Two</title>')}`
  const fresh = await createBinding(`var fresh = await cua.createBrowserTab(${JSON.stringify(freshDataOne)}, {newPanel:true}); await nodeRepl.write({testBinding:{panelId:fresh.panelId,tabId:fresh.tabId}});`)
  await runBrowser(`var second = await cua.createBrowserTab(${JSON.stringify(freshDataTwo)}, {panelId:fresh.panelId});`)
  const freshTabs = await runBrowser('await cua.listTabs();')
  expect(freshTabs).toContain(freshDataOne)
  expect(freshTabs).toContain(freshDataTwo)
  expect(await runCate(controlNode, 'panel', 'close', fresh.panelId)).toBe('ok')

  const opened = await createBinding(`var tab = await cua.createBrowserTab(${JSON.stringify(baseUrl)}, {newPanel:true}); await nodeRepl.write({testBinding:{panelId:tab.panelId,tabId:tab.tabId}});`)
  const browserId = opened.panelId
  expect(browserId).toMatch(/^[a-z0-9-]+$/i)
  const oracle = (expression: string) => fixtureEvaluate(app, page, { workspaceId: '', panelId: browserId }, expression)
  await runBrowser(`await tab.goto(${JSON.stringify(`${baseUrl}?opened=1`)});`)

  const firstDataUrl = `data:text/html,${encodeURIComponent('<title>Data One</title><h1>Data One</h1>')}`
  const secondDataUrl = `data:text/html,${encodeURIComponent('<title>Data Two</title><h1>Data Two</h1>')}`
  await runBrowser(`await tab.goto(${JSON.stringify(firstDataUrl)}); await tab.goto(${JSON.stringify(secondDataUrl)});`)
  expect(await runCate(controlNode, 'panel', 'list')).toContain(secondDataUrl)
  await runBrowser('await tab.back(); await tab.back();')

  const state = await runBrowser('await tab.getAXState({disableDiffing:true});')
  expect(state).toContain('Form Ready')
  expect(state).toContain('••••••••')
  expect(state).not.toContain('never-expose-me')
  await runBrowser(`var id = async function(name,role){
    var state=await tab.getAXState({disableDiffing:true,emit:false});
    var matches=state.elements.filter(e=>e.name.trim()===name&&(!role||e.role===role));
    if(matches.length!==1)throw Error("Expected unique accessible target: "+name);
    return matches[0].id;
  }; var query = await id("Query","searchbox"); var click = await id("Click me","button");`)

  await runBrowser('await tab.getScreenshot({emit:false}); await tab.setValue(query,"hello"); await tab.getScreenshot({emit:false}); await tab.typeText(" cate");')
  expect(await oracle('document.querySelector("#query").value')).toBe('hello cate')
  await runBrowser('await tab.click(click); await tab.waitFor({text:"Saved"},{timeoutMs:3000});')
  expect(await runBrowser('await tab.getAXState({disableDiffing:true});')).toContain('Clicked')
  await runBrowser('await tab.waitFor({element:query,state:"visible"}); await tab.selectText(query,"hello cate",{selectionType:"cursor_after"}); await tab.pressKey("Return");')
  expect(await oracle('document.title')).toBe('Submitted:hello cate')
  await runBrowser('await tab.pressKey("PageDown");')

  await runBrowser('await tab.click(await id("Semantic action","button"));')
  expect(await oracle('document.body.dataset.semantic')).toBe('clicked')
  await runBrowser('await tab.waitFor({element:query,state:"visible"}); await tab.waitFor({element:await id("Disabled action","button"),state:"disabled"});')
  await runBrowser('var option=await id("Optional setting","checkbox"); await tab.waitFor({element:option,state:"checked"}); await tab.setChecked(option,false); await tab.waitFor({element:option,state:"unchecked"});')
  expect(await oracle('document.querySelector("#option").checked')).toBe(false)
  await runBrowser('await tab.setChecked(option,true); await tab.click(await id("Double action","button"),{clickCount:2});')
  expect(await oracle('document.body.dataset.double')).toBe('received')
  // A targeted click must move the pointer onto the control before input.
  await runBrowser('await tab.click(await id("Hover action","button"));')
  expect(await oracle('document.body.dataset.hover')).toBe('received')

  await runBrowser('await tab.setValue(await id("Editor","textbox"),"Rich"); await tab.typeText(" text"); await tab.typeText(" via keyboard");')
  expect(await oracle('document.querySelector("#editor").textContent')).toBe('Rich text via keyboard')
  await runBrowser('await tab.selectOption(await id("Size","combobox"),["large"]);')
  expect(await oracle('document.querySelector("#size").value')).toBe('large')
  await runBrowser('await tab.scroll([400,300],"down",8);')
  await expect.poll(() => oracle('scrollY')).toBeGreaterThan(0)
  await runBrowser('await tab.scroll([400,300],"up",8);')
  await expect.poll(() => oracle('scrollY')).toBe(0)
  await runBrowser('await tab.getAXState(); await tab.drag([20,30],[40,50]);')
  expect(await oracle('document.body.dataset.mouse')).toBe('40,50')

  const screenshots = await runBrowser('await tab.getAXStateAndScreenshot();')
  const imagePath = screenshots.split('\n').find((line) => line.trim().endsWith('.png'))?.trim()
  expect(imagePath).toBeTruthy()
  expect(existsSync(imagePath!)).toBe(true)
  expect(readFileSync(imagePath!).subarray(1, 4).toString()).toBe('PNG')

  // The redesign intentionally removes arbitrary page evaluation and the old
  // command vocabulary. Rejection must leave the existing session usable.
  const legacy = await runInCateTerminal(controlNode, cate('browser', 'snapshot'))
  expect(legacy.code).not.toBe(0)
  const noDom = await runInCateTerminal(controlNode, cate('browser', 'run', 'await nodeRepl.write({pageEvaluation:typeof tab.evaluate,node:typeof require});'))
  expect(noDom.output).toContain('undefined')
  await runBrowser('await tab.reload(); await tab.getAXState();')
  await runCate(controlNode, 'browser', 'reset')
  expect(await runBrowser('await nodeRepl.write(typeof tab);')).toContain('undefined')

  // A second real terminal proves terminal type/press/read, not just the shell
  // hosting this test's CLI process.
  const workerId = await runCate(controlNode, 'panel', 'create', 'terminal')
  const workerNode = await nodeForPanel(workerId)
  await expect.poll(
    () => page.evaluate((id) => window.__cateE2E!.terminalPtyId(id), workerNode),
    { timeout: 30_000 },
  ).not.toBeNull()
  const workerOutput = path.join(workspace, 'cli-worker.out')
  const workerCommand = process.platform === 'win32'
    ? 'Set-Content -NoNewline cli-worker.out CLI_TARGET_OK; Get-Content cli-worker.out'
    : 'printf CLI_TARGET_OK > cli-worker.out; cat cli-worker.out'
  expect(await runCate(controlNode, 'terminal', 'type', workerCommand, '--panel', workerId)).toBe('ok')
  expect(await runCate(controlNode, 'terminal', 'press', 'enter', '--panel', workerId)).toBe('ok')
  await expect.poll(
    () => existsSync(workerOutput) ? readFileSync(workerOutput, 'utf8') : '',
    { timeout: 10_000 },
  ).toBe('CLI_TARGET_OK')
  expect(await runCate(controlNode, 'terminal', 'read', '--panel', workerId)).toContain('CLI_TARGET_OK')

  // The background activity monitor can lag behind the completed shell command.
  // Wait for its idle state before closing, so this smoke does not open the
  // native running-process confirmation dialog.
  await expect.poll(() => page.evaluate(id => window.__cateE2E!.terminalActivity(id), workerNode), { timeout: 30_000 }).toBe('idle')

  // Close verifies immediate list consistency for several panel types.
  expect(await runCate(controlNode, 'panel', 'close', workerId)).toBe('ok')
  expect(await runCate(controlNode, 'panel', 'close', browserId)).toBe('ok')
  expect(await runCate(controlNode, 'panel', 'close', editorId)).toBe('ok')
  const finalPanels = await runCate(controlNode, 'panel', 'list')
  expect(finalPanels).not.toContain(workerId)
  expect(finalPanels).not.toContain(browserId)
  expect(finalPanels).not.toContain(editorId)
})
