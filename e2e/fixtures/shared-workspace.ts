// Two clients in one workspace, for the shared-workspace suite (13):
//
// - `local`: two Electron instances with their own userData on one HOME, so
//   both dial the same runtime socket.
// - `network`: B has its own HOME, pairs through the link A's "Add device"
//   made (`pairing.createSecret`) and connects over the LAN WebSocket inside
//   the Noise layer.
//
// Every spec runs over both. A is the machine that holds the workspace; the
// runtime runs from `fullRuntimeInstall` (fake T3, ripgrep, the `cate` CLI).

import { expect, test } from '@playwright/test'
import type { Page } from 'playwright'
import { networkInterfaces } from 'node:os'
import { closeApp, launchApp, makeHome, makeProject, type LaunchResult } from './electron-app'
import { fullRuntimeInstall } from './runtime-install'
import type { CanvasE2EHooks } from '../../src/client/ui/e2e/e2eHarness'

export type Transport = 'local' | 'network'

/** Same-network pairing advertises LAN addresses; a loopback-only host has none. */
export const hasLan = Object.values(networkInterfaces()).flat().some((i) => !!i && !i.internal && i.family === 'IPv4')

export const TRANSPORTS: Transport[] = ['local', 'network']

export interface SharedClient {
  app: LaunchResult
  page: Page
  /** This client's id for the shared workspace (`paired:...` on a network B). */
  workspaceId: string
}

export interface SharedPair {
  transport: Transport
  a: SharedClient
  b: SharedClient
  /** The project folder, on A's machine. */
  project: string
  homeA: string
  close(): Promise<void>
}

export interface SharedPairOptions {
  git?: boolean
  files?: Record<string, string>
}

export async function launchSharedPair(transport: Transport, opts: SharedPairOptions = {}): Promise<SharedPair> {
  const homeA = makeHome()
  const project = makeProject(homeA, { git: opts.git ?? true, files: opts.files })
  const env = { CATE_RUNTIME_NODE: fullRuntimeInstall(homeA) }
  const a = await launchApp({ home: homeA, workspace: project, domTerminals: true, env })
  const aClient: SharedClient = { app: a, page: a.mainWindow, workspaceId: a.workspaceId! }

  let homeB: string | undefined
  let b: LaunchResult
  let bWorkspace: string
  if (transport === 'local') {
    b = await launchApp({ home: homeA, workspace: project, domTerminals: true, env })
    bWorkspace = b.workspaceId!
  } else {
    homeB = makeHome()
    b = await launchApp({ home: homeB, workspace: false, domTerminals: true })
    const secret = await a.mainWindow.evaluate(async () => {
      await window.__cateE2E!.call('settings', 'set', { key: 'runtimeNetwork', value: 'sameNetwork' })
      return window.__cateE2E!.call('pairing', 'createSecret', { mode: 'sameNetwork' })
    }) as { uri: string }
    bWorkspace = await b.mainWindow.evaluate((uri) => window.__cateE2E!.joinWorkspace(uri), secret.uri)
    await b.mainWindow.waitForFunction((ws) => !!window.__cateE2E!.document(ws), bWorkspace, { timeout: 30_000 })
  }
  const bClient: SharedClient = { app: b, page: b.mainWindow, workspaceId: bWorkspace }
  // B shows the canvas A made.
  await b.mainWindow.waitForSelector('[data-canvas-container]', { timeout: 30_000 })
  // Zoom is client state. Zoomed out, the nodes the specs spread over the
  // canvas stay on screen (off-screen nodes are not rendered).
  for (const page of [a.mainWindow, b.mainWindow]) {
    await page.evaluate(() => {
      const canvas = window.__cateE2E as unknown as CanvasE2EHooks
      canvas.resetViewport()
      canvas.setZoom(0.5)
    })
  }

  return {
    transport,
    a: aClient,
    b: bClient,
    project,
    homeA,
    async close() {
      await closeApp(b.electronApp, homeB ? { home: homeB } : {})
      await closeApp(a.electronApp, { home: homeA })
    },
  }
}

/**
 * Declares one serial describe block per transport, sharing one pair for the
 * block's tests. `body` receives a getter for the live pair.
 */
export function describeShared(title: string, body: (pair: () => SharedPair) => void, opts: SharedPairOptions = {}): void {
  for (const transport of TRANSPORTS) {
    test.describe(`${title} [${transport}]`, () => {
      test.describe.configure({ mode: 'serial' })
      test.skip(transport === 'network' && !hasLan, 'no LAN address on this host')
      let pair: SharedPair | undefined
      test.beforeAll(async () => {
        test.setTimeout(120_000)
        pair = await launchSharedPair(transport, opts)
      })
      test.afterAll(async () => { await pair?.close() })
      body(() => pair!)
    })
  }
}

// -----------------------------------------------------------------------------
// Harness shorthands, each against the client's own id for the workspace.
// -----------------------------------------------------------------------------

// The canvas view's hooks are spread onto `__cateE2E` (typed by CanvasE2EHooks).
export const nodes = (c: SharedClient) =>
  c.page.evaluate(() => (window.__cateE2E as unknown as CanvasE2EHooks).nodes())

export const nodeOf = async (c: SharedClient, nodeId: string) => (await nodes(c)).find((n) => n.id === nodeId)

export const moveNode = (c: SharedClient, nodeId: string, origin: { x: number; y: number }) =>
  c.page.evaluate(({ nodeId, origin }) => (window.__cateE2E as unknown as CanvasE2EHooks).moveNode(nodeId, origin), { nodeId, origin })

export const zoom = (c: SharedClient) => c.page.evaluate(() => (window.__cateE2E as unknown as CanvasE2EHooks).zoom())

export const setZoom = (c: SharedClient, value: number) =>
  c.page.evaluate((value) => (window.__cateE2E as unknown as CanvasE2EHooks).setZoom(value), value)

export const activeCanvasId = (c: SharedClient) =>
  c.page.evaluate(() => (window.__cateE2E as unknown as CanvasE2EHooks).activeCanvas()!.canvasId)

export const doc = (c: SharedClient) =>
  c.page.evaluate((ws) => window.__cateE2E!.document(ws), c.workspaceId)

export const call = <T = unknown>(c: SharedClient, cap: string, method: string, params?: unknown) =>
  c.page.evaluate(({ cap, method, params, ws }) => window.__cateE2E!.call(cap, method, params, ws), { cap, method, params, ws: c.workspaceId }) as Promise<T>

export const snapshot = <T = Record<string, unknown>>(c: SharedClient, panelId: string) =>
  c.page.evaluate(({ panelId, ws }) => window.__cateE2E!.sessionSnapshot(panelId, ws), { panelId, ws: c.workspaceId }) as Promise<T | null>

export const sessionOp = <T = unknown>(c: SharedClient, panelId: string, op: unknown) =>
  c.page.evaluate(({ panelId, op, ws }) => window.__cateE2E!.sessionOp(panelId, op, ws), { panelId, op, ws: c.workspaceId }) as Promise<T>

/** Runs a session op expecting a refusal; resolves the RpcError code ('ok' when it succeeded). */
export const sessionOpError = (c: SharedClient, panelId: string, op: unknown) =>
  c.page.evaluate(({ panelId, op, ws }) => window.__cateE2E!.sessionOp(panelId, op, ws).then(
    () => 'ok',
    (e: { code?: string; message?: string }) => e.code ?? e.message ?? 'error',
  ), { panelId, op, ws: c.workspaceId })

/** A capability call expecting a refusal; resolves the RpcError code ('ok' when it succeeded). */
export const callError = (c: SharedClient, cap: string, method: string, params?: unknown) =>
  c.page.evaluate(({ cap, method, params, ws }) => window.__cateE2E!.call(cap, method, params, ws).then(
    () => 'ok',
    (e: { code?: string; message?: string }) => e.code ?? e.message ?? 'error',
  ), { cap, method, params, ws: c.workspaceId })

export const propose = (c: SharedClient, change: unknown) =>
  c.page.evaluate(({ change, ws }) => window.__cateE2E!.propose(change as never, ws), { change, ws: c.workspaceId })

export const terminalText = (c: SharedClient, panelId: string) =>
  c.page.evaluate(({ panelId, ws }) => window.__cateE2E!.terminalText(panelId, ws), { panelId, ws: c.workspaceId }).catch(() => '')

export const writeTerminal = (c: SharedClient, panelId: string, data: string) =>
  c.page.evaluate(({ panelId, data, ws }) => window.__cateE2E!.writeTerminal(panelId, data, ws), { panelId, data, ws: c.workspaceId })

/** Creates a panel as a canvas node on `c`'s active canvas; waits for it in both clients. */
export async function seedShared(pair: SharedPair, from: SharedClient, type: string, origin = { x: 200, y: 200 }, options: Record<string, unknown> = {}): Promise<{ panelId: string; nodeId: string }> {
  const created = await from.page.evaluate(({ type, origin, options }) => window.__cateE2E!.createOnCanvas(type, origin, options), { type, origin, options })
  if (!created) throw new Error(`could not create ${type} on the canvas`)
  for (const c of [pair.a, pair.b]) await c.page.waitForSelector(`[data-node-id="${created.nodeId}"]`, { timeout: 20_000 })
  return created
}

/** Polls until `read` in both clients returns the same value matching `expected`. */
export async function expectBoth<T>(pair: SharedPair, read: (c: SharedClient) => Promise<T>, expected: T, timeout = 20_000): Promise<void> {
  await expect.poll(() => read(pair.a), { timeout }).toEqual(expected)
  await expect.poll(() => read(pair.b), { timeout }).toEqual(expected)
}
