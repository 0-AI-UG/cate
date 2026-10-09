// Starting agents end to end: a terminal runs `cate agent start ...`, which
// starts a terminal next to it running a fake `codex` on the runtime's PATH;
// the started agent is then a panel `cate agent` and the terminal reach.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { closeApp, expectTerminalText, makeHome, makeProject, seedOnCanvas } from './fixtures/electron-app'
import { layout } from './fixtures/canvas-helpers'
import { launchWithRuntime, stopRuntimeGracefully } from './fixtures/runtime-install'
import { cate, runInTerminal } from './fixtures/cate-terminal'

let app: ElectronApplication
let page: Page
let home = ''
let root = ''
let userDataDir = ''
let fakeBin = ''
let launchLog = ''
let control = ''

interface Started { panelId: string; runner: string; agentId: string | null }

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

/** `cate agent start`, given the call's own budget: the first hook
 *  inspection runs each agent CLI's own check (Hermes' plugin list), which
 *  is slow where that CLI is installed. */
async function start(prompt: string, ...flags: string[]): Promise<Started> {
  const { code, output } = await runInTerminal(page, control, cate('agent', '--json', 'start', '--agent', 'codex', ...flags, '--', prompt), 90_000)
  expect(code, output).toBe(0)
  return JSON.parse(output.replace(/\s*\n\s*/g, '')) as Started
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

const launches = () => (existsSync(launchLog) ? readFileSync(launchLog, 'utf8').trim().split('\n').filter(Boolean) : [])

test('starts a CLI agent with its prompt as argv, next to the calling terminal', async () => {
  test.setTimeout(120_000)
  const started = await start('--literal task; no shell')
  expect(started).toMatchObject({ runner: 'terminal', agentId: 'codex' })
  await expectTerminalText(page, started.panelId, 'FAKE_CODEX_STARTED', { timeout: 30_000 })

  const launched = JSON.parse(launches()[0]!)
  expect(launched.cwd).toBe(root)
  expect(launched.argv).toEqual(['Complete this coding task:\n\n--literal task; no shell'])

  // Placed on the caller's canvas, and an agent panel like any other.
  const { places } = await layout(page)
  expect(places[started.panelId]).toMatchObject({ kind: 'canvas', canvasId: places[control].canvasId })
  await page.evaluate((id) => window.__cateE2E!.writeTerminal(id, 'finish-e2e\r'), started.panelId)
  await expectTerminalText(page, started.panelId, 'FAKE_CODEX_FOLLOW_UP finish-e2e')
})

test('a started agent keeps running when its panel moves to a detached window', async () => {
  test.setTimeout(120_000)
  const started = await start('detach this agent')
  await expectTerminalText(page, started.panelId, 'FAKE_CODEX_STARTED', { timeout: 30_000 })
  const windows = app.windows().length
  // Detaching is a placement op: the panel's session stays in the runtime.
  await page.evaluate((id) => window.__cateE2E!.propose({
    kind: 'placePanel',
    id,
    at: { to: 'window', windowId: crypto.randomUUID(), stackId: crypto.randomUUID() },
  }), started.panelId)
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBeGreaterThan(windows)
  await page.evaluate((id) => window.__cateE2E!.writeTerminal(id, 'still-here\r'), started.panelId)
  await expectTerminalText(page, started.panelId, 'FAKE_CODEX_FOLLOW_UP still-here')
})

test('restart does not replay a started agent\'s prompt', async () => {
  test.setTimeout(120_000)
  const started = await start('finish once, never replay')
  await expectTerminalText(page, started.panelId, 'FAKE_CODEX_STARTED', { timeout: 30_000 })
  expect(launches()).toHaveLength(1)

  // A full app and runtime restart.
  await stopRuntimeGracefully(page, home)
  await closeApp(app)
  await launch()
  await page.waitForTimeout(3_000)
  expect(launches()).toHaveLength(1)
})
