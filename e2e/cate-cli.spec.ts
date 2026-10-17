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

test('cate browser commands drive a real browser panel webview', async () => {
  test.setTimeout(180_000)
  const control = (await seedOnCanvas(page, 'terminal', { x: 120, y: 120 })).panelId
  const runCate = (...args: string[]) => runCateIn(page, control, ...args)
  const browserId = await runCate('panel', 'create', 'browser')
  const browser = (...args: string[]) => runCate('browser', ...args, '--panel', browserId)
  const oracle = (expression: string) => guestEvaluate(app, baseUrl, expression)

  // Tabs: short handles, the agent's own marked as such.
  expect(await browser('tab', 'new', baseUrl)).toMatch(/tabId\s+t2/)
  expect(await browser('tab', 'list')).toMatch(/\*\s+\S+\s+t2\s+you\s/)

  const state = await browser('snapshot', '--screenshot')
  expect(state).toContain('Form Ready')
  expect(state).toContain('••••••••')
  expect(state).not.toContain('never-expose-me')
  const imagePath = state.split('\n').find((line) => line.startsWith('Screenshot: '))?.replace(/^Screenshot: /, '').trim()
  expect(imagePath && existsSync(imagePath)).toBeTruthy()

  // Elements by role and name instead of ids.
  expect(await browser('find', '--role', 'searchbox')).toMatch(/^- searchbox "Query" \[id=\d+\]$/)
  await browser('fill', '--role', 'searchbox', '--name', 'Query', 'hello')
  await browser('type', ' cate')
  expect(await oracle('document.querySelector("#query").value')).toBe('hello cate')
  await browser('click', '--role', 'button', '--name', 'Click me', '--exact')
  await browser('wait', '--text', 'Saved', '--timeout', '3000')
  await browser('select-text', '--role', 'searchbox', '--name', 'Query', 'hello cate', '--cursor', 'after')
  await browser('press', 'Enter')
  expect(await oracle('document.title')).toBe('Submitted:hello cate')

  // The agent closes what it opened; the panel's first tab stays.
  expect(await browser('tab', 'close', '--mine')).toMatch(/closed\s+t2/)
  expect(await browser('tab', 'list')).not.toMatch(/\st2\s/)
  // There is no code mode.
  const noRun = await runInTerminal(page, control, cate('browser', 'run', '1'))
  expect(noRun.output).toContain('unknown command: browser run')
})
