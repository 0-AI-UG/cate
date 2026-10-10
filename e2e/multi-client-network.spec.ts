// A second desktop client on "another machine" (13.2): client B has its own
// HOME and userData, pairs through the link A's "Add device" created
// (`pairing.createSecret`), and connects over the LAN WebSocket with the
// Noise layer. B then sees the document and a terminal session, opens a dev
// server on the runtime machine's localhost (with its hot-reload WebSocket)
// through loopback routing and the tunnel.
//
// Reaching a workspace through a deployed Cate Connect service is not tested
// here: the service lives in another repository.

import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import {
  closeApp,
  expectTerminalText,
  guestEvaluate,
  launchApp,
  makeHome,
  makeProject,
  seedOnCanvas,
  type LaunchResult,
} from './fixtures/electron-app'
import { startDevServer, type DevServer } from './fixtures/dev-server'

test.describe.configure({ mode: 'serial' })

// Same-network pairing advertises the machine's LAN addresses; a host with
// only loopback (some CI sandboxes) has none to offer.
const hasLan = Object.values(networkInterfaces()).flat().some((i) => !!i && !i.internal && i.family === 'IPv4')
test.skip(!hasLan, 'no LAN address on this host')

let a: LaunchResult | undefined
let b: LaunchResult | undefined
let homeA: string
let homeB: string
let pairedId: string
let devServer: DevServer | undefined

function runtimePid(home: string): number {
  const dir = path.join(home, '.cate', 'workspaces')
  const [id] = readdirSync(dir)
  return (JSON.parse(readFileSync(path.join(dir, id!, 'runtime.json'), 'utf8')) as { pid: number }).pid
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  homeA = makeHome()
  homeB = makeHome()
  a = await launchApp({ home: homeA, workspace: makeProject(homeA, { git: true }) })
  b = await launchApp({ home: homeB, workspace: false, domTerminals: true })

  // "Add device" on A: network access on, then a one-time pairing link.
  const secret = await a.mainWindow.evaluate(async () => {
    await window.__cateE2E!.call('settings', 'set', { key: 'runtimeNetwork', value: 'sameNetwork' })
    return window.__cateE2E!.call('pairing', 'createSecret', { mode: 'sameNetwork' })
  }) as { uri: string; code: string }
  expect(secret.uri).toMatch(/^cate:\/\/pair\?/)
  expect(secret.uri, 'the link carries LAN addresses').toMatch(/[?&]a=/)

  pairedId = await b.mainWindow.evaluate((uri) => window.__cateE2E!.joinWorkspace(uri), secret.uri)
  await b.mainWindow.waitForFunction((ws) => !!window.__cateE2E!.document(ws), pairedId, { timeout: 30_000 })
})

test.afterAll(async () => {
  await devServer?.close()
  await closeApp(b?.electronApp, { home: homeB })
  await closeApp(a?.electronApp, { home: homeA })
})

test('B pairs and connects over the network transport', async () => {
  expect(pairedId).toMatch(/^paired:/)
  expect(await b!.mainWindow.evaluate((ws) => window.__cateE2E!.connection(ws), pairedId)).toEqual({ kind: 'network', state: 'connected' })
  const devices = await a!.mainWindow.evaluate(() => window.__cateE2E!.call('pairing', 'list')) as unknown[]
  expect(devices).toHaveLength(1)
})

test('B sees the document and a terminal session', async () => {
  const canvasPanel = await a!.mainWindow.evaluate(() => window.__cateE2E!.activeCanvasPanelId())
  await expect.poll(() => b!.mainWindow.evaluate(() => window.__cateE2E!.activeCanvasPanelId())).toBe(canvasPanel)

  const { panelId, nodeId } = await seedOnCanvas(a!.mainWindow, 'terminal', { x: 100, y: 100 })
  await b!.mainWindow.waitForSelector(`[data-node-id="${nodeId}"] .xterm`, { timeout: 20_000 })
  await expectTerminalText(a!.mainWindow, panelId, /\S/)
  await a!.mainWindow.evaluate((id) => window.__cateE2E!.writeTerminal(id, 'echo over-the-lan-$((6*7))\r'), panelId)
  await expect(b!.mainWindow.locator(`[data-node-id="${nodeId}"] .xterm-rows`)).toContainText('over-the-lan-42', { timeout: 20_000 })
})

test('B opens a dev server on the runtime machine\'s localhost, hot-reload WebSocket included', async () => {
  devServer = await startDevServer()
  const url = `http://localhost:${devServer.port}/`
  await seedOnCanvas(b!.mainWindow, 'browser', { x: 900, y: 100 }, { url })

  await expect.poll(
    () => guestEvaluate(b!.electronApp, url, 'document.title').catch(() => null),
    { timeout: 30_000, message: 'the page loads and its WebSocket answers' },
  ).toBe('hmr:pong-ping')
  expect(devServer.requests).toContain('/')
  expect(devServer.messages).toContain('ping')

  // The open hot-reload socket belongs to the runtime daemon (the tunnel), not to B.
  if (process.platform !== 'win32') {
    const out = execFileSync('lsof', ['-a', '-n', '-P', '-p', String(runtimePid(homeA)), `-iTCP:${devServer.port}`], { encoding: 'utf8' })
    expect(out).toContain('ESTABLISHED')
  }
})
