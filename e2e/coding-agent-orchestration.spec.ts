import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  closeApp,
  launchApp,
  resetViewport,
  seedTerminal,
  titleBarCentre,
} from './fixtures/electron-app'

const OWNER = 'mission-e2e-owner'

interface RunResult {
  id: string
  panelId: string
  status: string
}

interface InvokeResult {
  ok: boolean
  result?: RunResult & Record<string, unknown>
  error?: string
}

let app: ElectronApplication
let page: Page
let root = ''
let userDataDir = ''
let fakeBin = ''
let launchLog = ''

function installFakeCodex(): void {
  fakeBin = path.join(root, 'bin')
  mkdirSync(fakeBin, { recursive: true })
  launchLog = path.join(root, 'codex-launches.jsonl')
  const implementation = path.join(fakeBin, 'fake-codex.cjs')
  writeFileSync(implementation, `
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
  const posixLauncher = path.join(fakeBin, 'codex')
  writeFileSync(
    posixLauncher,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-codex.cjs" "$@"\n`,
  )
  chmodSync(posixLauncher, 0o755)
  writeFileSync(
    path.join(fakeBin, 'codex.cmd'),
    `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.cjs" %*\r\n`,
  )
}

function launchOptions() {
  return {
    userDataDir,
    env: {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      CATE_E2E_PATH_PREPEND: fakeBin,
      CATE_FAKE_CODEX_LAUNCH_LOG: launchLog,
    },
  }
}

async function trustWorkspace(): Promise<void> {
  const opened = page.evaluate((workspaceRoot) =>
    window.__cateE2E!.setWorkspaceRoot(workspaceRoot), root)
  const trust = page.getByRole('button', { name: 'Trust and open' })
  if (await trust.isVisible({ timeout: 2_000 }).catch(() => false)) await trust.click()
  expect(await opened).toBe(true)
}

async function createWorker(prompt: string): Promise<RunResult> {
  const outcome = await page.evaluate(
    ({ owner, task }) => window.__cateE2E!.codingAgentInvoke(owner, 'create', {
      agentId: 'codex',
      prompt: task,
    }),
    { owner: OWNER, task: prompt },
  ) as InvokeResult
  expect(outcome.ok, outcome.error).toBe(true)
  expect(outcome.result).toBeTruthy()
  return outcome.result!
}

async function waitForWorkerOutput(panelId: string, expected: string): Promise<void> {
  await expect.poll(
    () => page.evaluate((id) => window.__cateE2E!.terminalTextForPanel(id), panelId),
    { timeout: 30_000 },
  ).toContain(expected)
}

test.beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cate-agent-e2e-')))
  userDataDir = path.join(root, 'user-data')
  installFakeCodex()
  ;({ electronApp: app, mainWindow: page } = await launchApp(launchOptions()))
  await trustWorkspace()
  expect(await page.evaluate(() => window.__cateE2E!.setCodingAgentHookMode('codex', 'on'))).toBe(true)
  const controlNode = await seedTerminal(page, { x: 80, y: 80 })
  await expect.poll(
    () => page.evaluate((id) => window.__cateE2E!.terminalPtyId(id), controlNode),
    { timeout: 60_000 },
  ).not.toBeNull()
})

test.afterEach(async () => {
  await closeApp(app)
  rmSync(root, { recursive: true, force: true })
})

test('creates, inspects, follows up, waits for, and stops real worker PTYs', async () => {
  test.setTimeout(120_000)
  const first = await createWorker('--literal mission; no shell')
  await waitForWorkerOutput(first.panelId, 'FAKE_CODEX_STARTED')

  const launch = JSON.parse(readFileSync(launchLog, 'utf8').trim())
  expect(launch.cwd).toBe(root)
  expect(launch.argv).toEqual([
    'Complete this coding task:\n\n--literal mission; no shell',
  ])

  const inspected = await page.evaluate(
    ({ owner, runId }) => window.__cateE2E!.codingAgentInvoke(owner, 'inspect', { runId }),
    { owner: OWNER, runId: first.id },
  ) as InvokeResult
  expect(inspected.ok).toBe(true)
  expect(inspected.result?.recentOutput).toContain('FAKE_CODEX_STARTED')

  const waited = page.evaluate(
    ({ owner, runId }) => window.__cateE2E!.codingAgentInvoke(owner, 'wait', {
      runIds: [runId],
      timeoutSeconds: 10,
    }),
    { owner: OWNER, runId: first.id },
  )
  const sent = await page.evaluate(
    ({ owner, runId }) => window.__cateE2E!.codingAgentInvoke(owner, 'send', {
      runId,
      prompt: 'finish-e2e',
    }),
    { owner: OWNER, runId: first.id },
  ) as InvokeResult
  expect(sent.ok, sent.error).toBe(true)
  const waitResult = await waited as InvokeResult
  expect(waitResult.ok, waitResult.error).toBe(true)
  expect(waitResult.result?.changedRunIds).toEqual([first.id])
  expect(waitResult.result?.runs).toEqual([
    expect.objectContaining({ id: first.id, status: 'ready' }),
  ])

  const second = await createWorker('stay alive until stopped')
  await waitForWorkerOutput(second.panelId, 'FAKE_CODEX_STARTED')
  const stopped = await page.evaluate(
    ({ owner, runId }) => window.__cateE2E!.codingAgentInvoke(owner, 'stop', { runId }),
    { owner: OWNER, runId: second.id },
  ) as InvokeResult
  expect(stopped.ok, stopped.error).toBe(true)
  expect(stopped.result).toEqual(expect.objectContaining({ id: second.id, status: 'stopped' }))
  expect(await page.evaluate(
    ({ owner, runId }) => window.__cateE2E!.codingAgentInvoke(owner, 'inspect', { runId }),
    { owner: OWNER, runId: second.id },
  )).toEqual(expect.objectContaining({ ok: true }))
})

test('a live worker survives transfer into a detached Electron window', async () => {
  test.setTimeout(120_000)
  await resetViewport(page)
  const worker = await createWorker('detach this worker')
  await waitForWorkerOutput(worker.panelId, 'FAKE_CODEX_STARTED')
  const nodeId = await expect.poll(
    () => page.evaluate((panelId) => window.__cateE2E!.nodeForPanel(panelId), worker.panelId),
    { timeout: 15_000 },
  ).not.toBeNull().then(() => page.evaluate(
    (panelId) => window.__cateE2E!.nodeForPanel(panelId), worker.panelId,
  ))
  expect(nodeId).toBeTruthy()
  const grab = await titleBarCentre(page, nodeId!)
  expect(grab).not.toBeNull()
  const initialWindowCount = app.windows().length
  const width = await page.evaluate(() => window.innerWidth)
  await page.mouse.move(grab!.x, grab!.y)
  await page.mouse.down()
  await page.mouse.move(grab!.x + 100, grab!.y, { steps: 10 })
  await page.mouse.move(width + 120, grab!.y)
  await page.waitForTimeout(300)
  await page.mouse.up()

  await expect.poll(() => app.windows().length, { timeout: 12_000 })
    .toBeGreaterThan(initialWindowCount)
  await page.waitForSelector(`[data-node-id="${nodeId}"]`, { state: 'detached' })
  await expect.poll(
    () => app.windows().some((candidate) => candidate.url().includes('type=dock')),
    { timeout: 12_000 },
  ).toBe(true)
  const detached = app.windows().find((candidate) => candidate.url().includes('type=dock'))!
  await detached.waitForFunction(() => window.__cateE2E?.ready === true)
  await expect.poll(
    () => detached.evaluate((id) => window.__cateE2E!.terminalTextForPanel(id), worker.panelId),
    { timeout: 30_000 },
  ).toContain('FAKE_CODEX_STARTED')
  const stopped = await detached.evaluate(
    ({ owner, runId }) => window.__cateE2E!.codingAgentInvoke(owner, 'stop', { runId }),
    { owner: OWNER, runId: worker.id },
  ) as InvokeResult
  expect(stopped.ok, stopped.error).toBe(true)
  expect(stopped.result).toEqual(expect.objectContaining({ status: 'stopped' }))
})

test('restart restores mission history without replaying the worker task', async () => {
  test.setTimeout(120_000)
  const worker = await createWorker('finish once, never replay')
  await waitForWorkerOutput(worker.panelId, 'FAKE_CODEX_STARTED')
  const sent = await page.evaluate(
    ({ owner, runId }) => window.__cateE2E!.codingAgentInvoke(owner, 'send', {
      runId,
      prompt: 'finish-e2e',
    }),
    { owner: OWNER, runId: worker.id },
  ) as InvokeResult
  expect(sent.ok, sent.error).toBe(true)
  await expect.poll(
    () => page.evaluate(
      ({ owner, runId }) => window.__cateE2E!.codingAgentRuns(owner).find((run) => run.id === runId)?.status,
      { owner: OWNER, runId: worker.id },
    ),
    { timeout: 15_000 },
  ).toBe('ready')
  expect(readFileSync(launchLog, 'utf8').trim().split('\n')).toHaveLength(1)

  await closeApp(app)
  ;({ electronApp: app, mainWindow: page } = await launchApp(launchOptions()))
  await expect.poll(
    () => page.evaluate(
      ({ owner, runId }) => window.__cateE2E!.codingAgentRuns(owner).find((run) => run.id === runId)?.status,
      { owner: OWNER, runId: worker.id },
    ),
    { timeout: 30_000 },
  ).toBe('ready')
  expect(existsSync(launchLog) ? readFileSync(launchLog, 'utf8').trim().split('\n') : []).toHaveLength(1)
})
