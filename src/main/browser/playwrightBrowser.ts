import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { app, type WebContents } from 'electron'
import type { Browser, Frame } from 'playwright-core'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import log from '../logger'

const TARGET_MARKER = '__catePlaywrightTarget'
const DEVTOOLS_ACTIVE_PORT = 'DevToolsActivePort'
const CONNECT_TIMEOUT_MS = 5_000
const TARGET_TIMEOUT_MS = 3_000

type KeyboardModifier = 'Alt' | 'Control' | 'Meta' | 'Shift'
type MouseButton = 'left' | 'right' | 'middle'

export type PlaywrightBrowserAction =
  | 'click'
  | 'dblclick'
  | 'hover'
  | 'fill'
  | 'type'
  | 'press'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'drag'

export interface PlaywrightBrowserRequest {
  action: PlaywrightBrowserAction
  ref?: string
  targetRef?: string
  text?: string
  key?: string
  values?: string[]
  button?: MouseButton
  modifiers?: KeyboardModifier[]
  delay?: number
}

interface BrowserTarget {
  token: string
  panelId: string
  tabId: string
}

const targets = new Map<number, BrowserTarget>()
const frames = new Map<number, Frame>()
let browserPromise: Promise<Browser> | null = null
let cdpAdapterPromise: Promise<string> | null = null
let cdpAdapter: WebSocketServer | null = null

/**
 * Playwright attaches to Cate's own Electron Chromium over a random loopback
 * CDP port. Port 0 asks Chromium to allocate the port and write it to
 * DevToolsActivePort inside Cate's private userData directory.
 */
export function enablePlaywrightBrowserBackend(): void {
  if (!app.commandLine.hasSwitch('remote-debugging-port')) {
    app.commandLine.appendSwitch('remote-debugging-port', '0')
  }
}

function markerScript(token: string): string {
  return `Object.defineProperty(globalThis, ${JSON.stringify(TARGET_MARKER)}, ` +
    `{ value: ${JSON.stringify(token)}, configurable: false, enumerable: false, writable: false })`
}

/** Register (or refresh after navigation) one browser guest for Playwright. */
export async function registerPlaywrightBrowserTarget(
  contents: WebContents,
  panelId: string,
  tabId: string,
): Promise<void> {
  let target = targets.get(contents.id)
  if (!target) {
    target = { token: randomUUID(), panelId, tabId }
    targets.set(contents.id, target)
    contents.once('destroyed', () => {
      targets.delete(contents.id)
      frames.delete(contents.id)
    })
  } else {
    target.panelId = panelId
    target.tabId = tabId
  }

  frames.delete(contents.id)
  await contents.executeJavaScript(markerScript(target.token), true)
}

async function readDevToolsEndpoint(): Promise<string> {
  const file = path.join(app.getPath('userData'), DEVTOOLS_ACTIVE_PORT)
  const deadline = Date.now() + CONNECT_TIMEOUT_MS
  for (;;) {
    try {
      const [port, browserPath] = (await fs.promises.readFile(file, 'utf8')).trim().split(/\r?\n/, 2)
      if (port && browserPath) return `ws://127.0.0.1:${port}${browserPath}`
    } catch {
      // Chromium creates the file asynchronously after app-ready.
    }
    if (Date.now() >= deadline) throw new Error('DevToolsActivePort was not created')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function rewriteWebviewTargets(data: RawData): string | Buffer {
  const text = typeof data === 'string'
    ? data
    : Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data).toString('utf8')
  try {
    const message = JSON.parse(text) as {
      method?: string
      params?: { targetInfo?: { type?: string } }
      result?: { targetInfos?: Array<{ type?: string }> }
    }
    if (message.params?.targetInfo?.type === 'webview') {
      // Playwright's PW_CHROMIUM_ATTACH_TO_OTHER path creates a normal Page
      // without assuming the target owns a native BrowserWindow.
      message.params.targetInfo.type = 'other'
    }
    for (const target of message.result?.targetInfos ?? []) {
      if (target.type === 'webview') target.type = 'other'
    }
    return JSON.stringify(message)
  } catch {
    return Buffer.isBuffer(data) ? data : text
  }
}

async function cdpAdapterEndpoint(): Promise<string> {
  if (cdpAdapterPromise) return cdpAdapterPromise
  cdpAdapterPromise = (async () => {
    const upstreamEndpoint = await readDevToolsEndpoint()
    const endpointToken = randomUUID()
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    cdpAdapter = server

    server.on('connection', (client: WebSocket, request: { url?: string }) => {
      if (request.url !== `/${endpointToken}`) {
        client.close(1008, 'invalid endpoint')
        return
      }

      const upstream = new WebSocket(upstreamEndpoint)
      const pending: Array<{ data: RawData; binary: boolean }> = []
      client.on('message', (data: RawData, binary: boolean) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
        else pending.push({ data, binary })
      })
      upstream.once('open', () => {
        for (const message of pending.splice(0)) {
          upstream.send(message.data, { binary: message.binary })
        }
      })
      upstream.on('message', (data: RawData, binary: boolean) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(rewriteWebviewTargets(data), { binary })
        }
      })
      upstream.once('close', () => {
        if (client.readyState === WebSocket.OPEN) client.close()
      })
      client.once('close', () => {
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
          upstream.close()
        }
      })
      upstream.once('error', (error) => {
        log.warn('[browser:playwright] CDP upstream failed: %s', error.message)
        if (client.readyState === WebSocket.OPEN) client.close(1011, 'CDP connection failed')
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    const address = server.address()
    if (typeof address === 'string') throw new Error('Expected TCP CDP adapter address')
    return `ws://127.0.0.1:${address.port}/${endpointToken}`
  })().catch((error) => {
    cdpAdapterPromise = null
    cdpAdapter?.close()
    cdpAdapter = null
    throw error
  })
  return cdpAdapterPromise
}

async function playwrightBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1'
      const { chromium } = await import('playwright-core')
      const endpoint = await cdpAdapterEndpoint()
      const browser = await chromium.connectOverCDP(endpoint, { timeout: CONNECT_TIMEOUT_MS })
      browser.once('disconnected', () => {
        browserPromise = null
        frames.clear()
      })
      return browser
    })().catch((error) => {
      browserPromise = null
      throw error
    })
  }
  return browserPromise
}

async function frameMarker(frame: Frame): Promise<string | null> {
  try {
    return await frame.evaluate((key) => {
      const value = (globalThis as Record<string, unknown>)[key]
      return typeof value === 'string' ? value : null
    }, TARGET_MARKER)
  } catch {
    return null
  }
}

async function findTargetFrame(webContentsId: number): Promise<Frame | null> {
  const target = targets.get(webContentsId)
  if (!target) return null

  const cached = frames.get(webContentsId)
  if (cached && await frameMarker(cached) === target.token) return cached
  frames.delete(webContentsId)

  const browser = await playwrightBrowser()
  const deadline = Date.now() + TARGET_TIMEOUT_MS
  for (;;) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        for (const frame of page.frames()) {
          if (await frameMarker(frame) === target.token) {
            frames.set(webContentsId, frame)
            return frame
          }
        }
      }
    }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function selectorForRef(ref: string | undefined): string | null {
  return ref && /^@s\d+e\d+$/.test(ref) ? `[data-cate-ref="${ref}"]` : null
}

/**
 * Run semantic browser input through Playwright. The renderer still owns the
 * visible agent cursor and ref snapshot format; Playwright owns auto-waiting,
 * hit testing, focus, trusted input, and cross-process iframe dispatch.
 */
export async function runPlaywrightBrowserAction(
  webContentsId: number,
  request: PlaywrightBrowserRequest,
): Promise<{ ok?: true; error?: string }> {
  try {
    const frame = await findTargetFrame(webContentsId)
    if (!frame) return { error: 'playwright-unavailable' }

    const selector = selectorForRef(request.ref)
    const targetSelector = selectorForRef(request.targetRef)
    const locator = selector ? frame.locator(selector) : null
    const common = {
      timeout: TARGET_TIMEOUT_MS,
      modifiers: request.modifiers,
    }

    switch (request.action) {
      case 'click':
      case 'dblclick':
        if (!locator) return { error: 'ref-required' }
        await locator.click({
          ...common,
          button: request.button,
          clickCount: request.action === 'dblclick' ? 2 : 1,
        })
        return { ok: true }
      case 'hover':
        if (!locator) return { error: 'ref-required' }
        await locator.hover({ ...common })
        return { ok: true }
      case 'fill':
        if (!locator) return { error: 'ref-required' }
        await locator.fill(request.text ?? '', { timeout: TARGET_TIMEOUT_MS })
        return { ok: true }
      case 'type':
        if (!locator) return { error: 'ref-required' }
        await locator.pressSequentially(request.text ?? '', {
          delay: request.delay,
          timeout: TARGET_TIMEOUT_MS,
        })
        return { ok: true }
      case 'press':
        if (!request.key) return { error: 'key-required' }
        if (locator) await locator.press(request.key, { timeout: TARGET_TIMEOUT_MS })
        else await frame.page().keyboard.press(request.key)
        return { ok: true }
      case 'select':
        if (!locator) return { error: 'ref-required' }
        await locator.selectOption(request.values ?? [], { timeout: TARGET_TIMEOUT_MS })
        return { ok: true }
      case 'check':
      case 'uncheck':
        if (!locator) return { error: 'ref-required' }
        await locator.setChecked(request.action === 'check', { timeout: TARGET_TIMEOUT_MS })
        return { ok: true }
      case 'drag':
        if (!locator || !targetSelector) return { error: 'ref-required' }
        await locator.dragTo(frame.locator(targetSelector), { timeout: TARGET_TIMEOUT_MS })
        return { ok: true }
    }
  } catch (error) {
    log.warn('[browser:playwright] action failed: %s', error instanceof Error ? error.message : String(error))
    return { error: error instanceof Error ? error.message : 'playwright-action-failed' }
  }
}

/**
 * Fill one imported credential without returning its password through IPC.
 * The opaque target marker is planted by the isolated browserGuest preload
 * when the user focuses a password input.
 */
export async function runPlaywrightCredentialAutofill(
  webContentsId: number,
  targetId: string,
  credential: { username: string; password: string; usernameElement: string },
): Promise<{ ok?: true; error?: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(targetId)) return { error: 'invalid-autofill-target' }
  try {
    const frame = await findTargetFrame(webContentsId)
    if (!frame) return { error: 'playwright-unavailable' }

    const password = frame.locator(`[data-cate-autofill-target=${JSON.stringify(targetId)}]`).first()
    const isPassword = await password.evaluate((element) =>
      element instanceof HTMLInputElement && element.type.toLowerCase() === 'password')
    if (!isPassword) return { error: 'autofill-target-not-password' }

    if (credential.username) {
      let username = credential.usernameElement
        ? frame.locator(`input[name=${JSON.stringify(credential.usernameElement)}]`).first()
        : null
      if (!username || await username.count() === 0 || !await username.isVisible()) {
        const form = password.locator('xpath=ancestor::form[1]')
        const scope = await form.count() > 0 ? form : frame.locator('body')
        username = scope
          .locator('input[autocomplete="username"], input[autocomplete="email"], input[type="email"], input[type="text"]')
          .last()
      }
      if (await username.count() > 0 && await username.isVisible()) {
        await username.fill(credential.username, { timeout: TARGET_TIMEOUT_MS })
      }
    }

    await password.fill(credential.password, { timeout: TARGET_TIMEOUT_MS })
    return { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'credential-autofill-failed' }
  }
}
