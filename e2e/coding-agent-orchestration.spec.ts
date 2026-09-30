// Coding-agent missions end to end: a supervising terminal runs `cate
// codingAgent ...` (the caller's panel owns the missions), which starts worker
// terminals running a fake `codex` on the runtime's PATH.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { closeApp, expectTerminalText, makeHome, makeProject, seedOnCanvas } from './fixtures/electron-app'
import { launchWithRuntime, stopRuntimeGracefully } from './fixtures/runtime-install'
import { cate, runCate, runInTerminal, shellQuote } from './fixtures/cate-terminal'

let app: ElectronApplication
let page: Page
let home = ''
let root = ''
let userDataDir = ''
let fakeBin = ''
let launchLog = ''
let control = ''

interface Run { id: string; panelId: string; status: string; [key: string]: unknown }

function installFakeCodex(): void {
  fakeBin = path.join(home, 'bin')
  mkdirSync(fakeBin, { recursive: true })
  launchLog = path.join(home, 'codex-launches.jsonl')
  writeFileSync(path.join(fakeBin, 'fake-codex.cjs'), `
const fs = require('node:fs')
const launch = { argv: process.argv.slice(2), cwd: process.cwd() }
fs.appendFileSync(process.env.CATE_FAKE_CODEX_LAUNCH_LOG, JSON.stringify(launch) + '\\n')
console.log('FAKE_CODEX_STARTED ' + JSON.stringify(launch.argv))
process.stdin.setEncoding('utf8')
let input = ''
process.stdin.on('data', (chunk) => {
  input += chunk.replace(/\\x1b\\[200~/g, '').replace(/\\x1b\\[201~/g, '')
  const parts = input.split(/[\\r\\n]+/)
  input = parts.pop() || ''
  for (const prompt of parts.filter(Boolean)) {
    console.log('FAKE_CODEX_FOLLOW_UP ' + prompt)
    if (prompt.includes('finish-e2e')) setTimeout(() => process.exit(0), 25)
  }
})
setInterval(() => {}, 1000)
`)
  const launcher = path.join(fakeBin, 'codex')
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-codex.cjs" "$@"\n`)
  chmodSync(launcher, 0o755)
  // Login shells rebuild PATH (macOS path_helper): put the fake first from the
  // test HOME's own profile, so a real `codex` never runs.
  const profile = `export PATH=${JSON.stringify(fakeBin)}:"$PATH"\n`
  for (const file of ['.zprofile', '.zshrc', '.bash_profile', '.profile']) writeFileSync(path.join(home, file), profile)
}

async function launch(): Promise<void> {
  ;({ electronApp: app, mainWindow: page } = await launchWithRuntime({
    home,
    userDataDir,
    workspace: root,
    env: {
      // The runtime is started by the shell: its terminals see this PATH.
      CATE_E2E_PATH_PREPEND: fakeBin,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      CATE_FAKE_CODEX_LAUNCH_LOG: launchLog,
    },
  }))
}

async function agent(...args: string[]): Promise<unknown> {
  const out = await runCate(page, control, 'codingAgent', '--json', ...args)
  return JSON.parse(out.replace(/\s*\n\s*/g, ''))
}

test.beforeEach(async () => {
  home = makeHome()
  root = realpathSync(makeProject(home, { git: true }))
  userDataDir = path.join(home, 'ud')
  installFakeCodex()
  await launch()
  await page.evaluate(() => window.__cateE2E!.call('settings', 'set', { key: 'agentHookInjection', value: { codex: 'on' } }))
  control = (await seedOnCanvas(page, 'terminal', { x: 80, y: 80 })).panelId
  await expectTerminalText(page, control, /\S/)
})
test.afterEach(async () => closeApp(app, { home }))

const create = (prompt: string) => agent('create', '--agent', 'codex', '--', prompt) as Promise<Run>
const launches = () => (existsSync(launchLog) ? readFileSync(launchLog, 'utf8').trim().split('\n').filter(Boolean) : [])

test('creates, inspects, follows up, waits for, and stops real worker PTYs', async () => {
  test.setTimeout(120_000)
  const first = await create('--literal mission; no shell')
  await expectTerminalText(page, first.panelId, 'FAKE_CODEX_STARTED', { timeout: 30_000 })

  const launched = JSON.parse(launches()[0]!)
  expect(launched.cwd).toBe(root)
  expect(launched.argv).toEqual(['Complete this coding task:\n\n--literal mission; no shell'])

  const inspected = await agent('inspect', first.id) as Run
  expect(JSON.stringify(inspected)).toContain('FAKE_CODEX_STARTED')

  // `wait` runs in the background of the supervising shell (missions belong
  // to their caller's panel) while a follow-up finishes the worker.
  const waitFile = path.join(home, 'wait.json')
  await runInTerminal(page, control, `${cate('codingAgent', '--json', 'wait', first.id, '--timeout', '20')} > ${shellQuote(waitFile)} 2>&1 &`)
  await page.waitForTimeout(500)
  await agent('send', first.id, 'finish-e2e')
  await expect.poll(() => (existsSync(waitFile) ? readFileSync(waitFile, 'utf8') : ''), { timeout: 30_000 }).toContain('changedRunIds')
  const waited = JSON.parse(readFileSync(waitFile, 'utf8')) as { changedRunIds: string[]; runs: Run[] }
  expect(waited.changedRunIds).toEqual([first.id])
  expect(waited.runs).toEqual([expect.objectContaining({ id: first.id, status: 'ready' })])

  const second = await create('stay alive until stopped')
  await expectTerminalText(page, second.panelId, 'FAKE_CODEX_STARTED', { timeout: 30_000 })
  const stopped = await agent('stop', second.id) as Run
  expect(stopped).toEqual(expect.objectContaining({ id: second.id, status: 'stopped' }))
  expect(await agent('inspect', second.id)).toEqual(expect.objectContaining({ id: second.id }))
})

test('a live worker keeps running when its panel moves to a detached window', async () => {
  test.setTimeout(120_000)
  const worker = await create('detach this worker')
  await expectTerminalText(page, worker.panelId, 'FAKE_CODEX_STARTED', { timeout: 30_000 })
  const windows = app.windows().length
  // Detaching is a placement op: the panel's session stays in the runtime.
  await page.evaluate((id) => window.__cateE2E!.propose({
    kind: 'placePanel',
    id,
    at: { to: 'window', windowId: crypto.randomUUID(), stackId: crypto.randomUUID(), bounds: { origin: { x: 80, y: 80 }, size: { width: 700, height: 500 } } },
  }), worker.panelId)
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBeGreaterThan(windows)
  await page.evaluate((id) => window.__cateE2E!.writeTerminal(id, 'still-here\r'), worker.panelId)
  await expectTerminalText(page, worker.panelId, 'FAKE_CODEX_FOLLOW_UP still-here')
  expect(await agent('stop', worker.id)).toEqual(expect.objectContaining({ status: 'stopped' }))
})

test('restart restores mission history without replaying the worker task', async () => {
  test.setTimeout(120_000)
  const worker = await create('finish once, never replay')
  await expectTerminalText(page, worker.panelId, 'FAKE_CODEX_STARTED', { timeout: 30_000 })
  await agent('send', worker.id, 'finish-e2e')
  const status = async () => ((await agent('list')) as Run[] | { runs: Run[] })
  const statusOf = async () => { const l = await status(); return (Array.isArray(l) ? l : l.runs).find((r) => r.id === worker.id)?.status }
  await expect.poll(statusOf, { timeout: 20_000 }).toBe('ready')
  expect(launches()).toHaveLength(1)

  // A full app and runtime restart.
  await stopRuntimeGracefully(page, home)
  await closeApp(app)
  await launch()
  await expect.poll(statusOf, { timeout: 30_000 }).toBe('ready')
  expect(launches()).toHaveLength(1)
})
