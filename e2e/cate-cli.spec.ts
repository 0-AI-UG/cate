// Real Cate CLI E2E. Unlike src/cli/cate.integration.test.ts (scripted HTTP),
// this launches Electron, provisions Cate's runtime, types commands into a real
// Cate terminal, and drives a real BrowserPanel webview through CATE_API.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import http from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { closeApp, launchApp, seedTerminal } from './fixtures/electron-app'

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
  expect(await page.evaluate((root) => window.__cateE2E!.setWorkspaceRoot(root), workspace)).toBe(true)
  // Terminal input is the only CLI permission disabled by default. Enable it
  // through the real settings IPC so terminal type/press can be exercised.
  await page.evaluate(() => window.electronAPI.settingsSet('cliTerminalInputEnabled', true))
})

test.afterEach(async () => {
  await closeApp(app)
  rmSync(workspace, { recursive: true, force: true })
})

test('every cate CLI command works from a real Cate terminal', async () => {
  test.setTimeout(180_000)
  const controlNode = await seedTerminal(page, { x: 120, y: 120 })
  await expect.poll(
    () => page.evaluate((id) => window.__cateE2E!.terminalPtyId(id), controlNode),
    { timeout: 60_000 },
  ).not.toBeNull()

  // Process/transport basics.
  expect(await runCate(controlNode, '--version')).toMatch(/^cate cli \d+$/)
  expect(await runCate(controlNode, '--help')).toContain('browser    open <url>')
  expect(await runCate(controlNode, 'version')).toBe('4')
  expect(await runCate(controlNode, 'panel', 'list')).toContain('terminal')
  expect(await runCate(controlNode, 'panel', 'set-title', 'CLI Control')).toBe('ok')
  expect(await runCate(controlNode, 'panel', 'list')).toContain('CLI Control')
  expect(await runCate(controlNode, 'ui', 'notify', 'CLI E2E notification')).toBe('ok')

  // Editor + panel verbs.
  const editorId = await runCate(controlNode, 'editor', 'open', `${path.join(workspace, 'cli-fixture.ts')}:1:8`)
  expect(editorId).toMatch(/^[a-z0-9-]{8}$/i)
  expect(await runCate(controlNode, 'panel', 'focus', editorId)).toBe('ok')
  expect(await runCate(controlNode, 'panel', 'list')).toContain('cli-fixture.ts')

  // Browser verbs against a real Electron webview and local HTTP page.
  const browserId = await runCate(controlNode, 'panel', 'create', 'browser', baseUrl)
  expect(browserId).toMatch(/^[a-z0-9-]{8}$/i)
  expect(await runCate(controlNode, 'browser', 'open', `${baseUrl}?opened=1`, '--panel', browserId)).toBe(`${baseUrl}?opened=1`)
  expect(await runCate(controlNode, 'browser', 'wait', '8000', '--panel', browserId)).toBe(`${baseUrl}?opened=1`)

  let snapshot = await runCate(controlNode, 'browser', 'snapshot', '--panel', browserId)
  expect(snapshot).toContain('title: Form Ready')
  expect(snapshot).toContain('••••••••')
  expect(snapshot).not.toContain('never-expose-me')
  let queryRef = snapshot.match(/\[(@s\d+e\d+)\] input:search "Query"/)?.[1]
  const clickRef = snapshot.match(/\[(@s\d+e\d+)\] button "Click me"/)?.[1]
  expect(queryRef).toBeTruthy()
  expect(clickRef).toBeTruthy()

  expect(await runCate(controlNode, 'browser', 'fill', queryRef!, 'hello', '--panel', browserId)).toBe('ok')
  expect(await runCate(controlNode, 'browser', 'type', queryRef!, 'hello cate', '--panel', browserId)).toBe('ok')
  snapshot = await runCate(controlNode, 'browser', 'snapshot', '--panel', browserId)
  expect(snapshot).toContain('= "hello cate"')
  const currentClickRef = snapshot.match(/\[(@s\d+e\d+)\] button "Click me"/)?.[1]
  const clickObservation = await runCate(
    controlNode, 'browser', 'click', currentClickRef!, '--snapshot', '--panel', browserId,
  )
  expect(clickObservation).toContain('title: Clicked')
  const savedObservation = await runCate(
    controlNode, 'browser', 'wait', 'text', 'Saved', '--wait-timeout', '3000', '--snapshot', '--panel', browserId,
  )
  expect(savedObservation).toContain('title: Clicked')
  expect(await runCate(
    controlNode, 'browser', 'wait', 'gone', 'Loading', '--wait-timeout', '3000', '--panel', browserId,
  )).toBe(`${baseUrl}?opened=1`)
  expect(await runCate(
    controlNode, 'browser', 'wait', 'url', '**?opened=1', '--wait-timeout', '3000', '--panel', browserId,
  )).toBe(`${baseUrl}?opened=1`)
  queryRef = savedObservation.match(/\[(@s\d+e\d+)\] input:search "Query"/)?.[1]
  expect(queryRef).toBeTruthy()
  expect(await runCate(
    controlNode, 'browser', 'wait', 'ref', queryRef!, 'visible', '--wait-timeout', '3000', '--panel', browserId,
  )).toBe(`${baseUrl}?opened=1`)
  expect(await runCate(controlNode, 'browser', 'press', queryRef!, 'Enter', '--panel', browserId)).toBe('ok')
  expect(await runCate(controlNode, 'browser', 'snapshot', '--panel', browserId)).toContain('title: Submitted:hello cate')
  expect(await runCate(controlNode, 'browser', 'press', 'PageDown', '--panel', browserId)).toBe('ok')

  const screenshot = await runCate(controlNode, 'browser', 'screenshot', '--panel', browserId)
  expect(screenshot).toMatch(/\.png$/)
  expect(existsSync(screenshot)).toBe(true)
  expect(await runCate(controlNode, 'browser', 'reload', '--panel', browserId)).toBe('ok')
  await runCate(controlNode, 'browser', 'wait', '8000', '--panel', browserId)

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
  expect(await runCate(controlNode, 'terminal', 'read', '--max', '20', '--panel', workerId)).toContain('CLI_TARGET_OK')

  // Close verifies immediate list consistency for several panel types.
  expect(await runCate(controlNode, 'panel', 'close', workerId)).toBe('ok')
  expect(await runCate(controlNode, 'panel', 'close', browserId)).toBe('ok')
  expect(await runCate(controlNode, 'panel', 'close', editorId)).toBe('ok')
  const finalPanels = await runCate(controlNode, 'panel', 'list')
  expect(finalPanels).not.toContain(workerId)
  expect(finalPanels).not.toContain(browserId)
  expect(finalPanels).not.toContain(editorId)
})
