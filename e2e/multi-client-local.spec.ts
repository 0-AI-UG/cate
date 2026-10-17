// Two desktop clients in one workspace over the local transport (13): two
// Electron instances with their own userData on one HOME, so both dial the
// same runtime socket. The document, sessions and presence are shared.

import { test, expect } from '@playwright/test'
import type { Page } from 'playwright'
import { closeApp, expectTerminalText, launchApp, makeHome, makeProject, seedOnCanvas, type LaunchResult } from './fixtures/electron-app'

let a: LaunchResult | undefined
let b: LaunchResult | undefined
let home: string

test.beforeEach(async () => {
  home = makeHome()
  const project = makeProject(home)
  a = await launchApp({ home, workspace: project, domTerminals: true })
  b = await launchApp({ home, workspace: project, domTerminals: true })
})

test.afterEach(async () => {
  await closeApp(b?.electronApp)
  await closeApp(a?.electronApp, { home })
  a = b = undefined
})

const nodes = (page: Page) => page.evaluate(() => window.__cateE2E!.nodes())

test('both clients reach the same runtime over the local socket', async () => {
  expect(a!.workspaceId).toBe(b!.workspaceId)
  expect(await a!.mainWindow.evaluate(() => window.__cateE2E!.connection())).toEqual({ kind: 'local', state: 'connected' })
  expect(await b!.mainWindow.evaluate(() => window.__cateE2E!.connection())).toEqual({ kind: 'local', state: 'connected' })
})

test('a panel added in A appears in B, and a move in B shows in A', async () => {
  const { panelId, nodeId } = await seedOnCanvas(a!.mainWindow, 'terminal', { x: 120, y: 80 })

  await expect.poll(async () => (await nodes(b!.mainWindow)).find((n) => n.id === nodeId)?.panelId).toBe(panelId)
  await b!.mainWindow.waitForSelector(`[data-node-id="${nodeId}"]`)

  await b!.mainWindow.evaluate((id) => window.__cateE2E!.moveNode(id, { x: 640, y: 360 }), nodeId)
  await expect.poll(async () => (await nodes(a!.mainWindow)).find((n) => n.id === nodeId)?.origin).toEqual({ x: 640, y: 360 })
})

test('typing in a terminal in A shows in B', async () => {
  const { panelId, nodeId } = await seedOnCanvas(a!.mainWindow, 'terminal', { x: 120, y: 80 })
  await b!.mainWindow.waitForSelector(`[data-node-id="${nodeId}"] .xterm`, { timeout: 15_000 })
  // Wait for the shell prompt before typing.
  await expectTerminalText(a!.mainWindow, panelId, /\S/)

  // Real keystrokes into A's xterm.
  const overlay = a!.mainWindow.locator(`[data-node-id="${nodeId}"] [data-unfocused-overlay]`)
  if (await overlay.count()) await overlay.click()
  await a!.mainWindow.focus(`[data-node-id="${nodeId}"] .xterm-helper-textarea`)
  await a!.mainWindow.keyboard.type('echo shared-$((6*7))')
  await a!.mainWindow.keyboard.press('Enter')

  // B renders the same PTY (xterm DOM renderer, so the text is in the DOM).
  await expect(b!.mainWindow.locator(`[data-node-id="${nodeId}"] .xterm-rows`)).toContainText('shared-42', { timeout: 20_000 })
})

test('B sees A connected', async () => {
  type Presence = { clients: { clientId: string; device: { name: string }; features: string[] }[] }
  const presence = async (page: Page) => page.evaluate(() => window.__cateE2E!.presence()) as Promise<Presence>
  await expect.poll(async () => (await presence(b!.mainWindow)).clients.length).toBe(2)
  const clients = (await presence(b!.mainWindow)).clients
  const aId = await a!.mainWindow.evaluate(() => window.__cateE2E!.clientId())
  expect(clients.map((c) => c.clientId)).toContain(aId)
  expect(clients.find((c) => c.clientId === aId)!.features).toContain('canvas')
})
