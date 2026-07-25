// =============================================================================
// browserControl — main-process half of the `cate.browser.*` agent surface.
//
// Most browser verbs are satisfiable from the renderer by driving the <webview>
// tag (executeJavaScript + sendInputEvent). The ones here are NOT: they need a
// real webContents, the CDP debugger, or an app-global Electron module.
//
//   fullPage / rect screenshots  capturePage(rect) and a CDP-backed
//                                scroll-and-stitch capture — a <webview> tag can
//                                only ever capture what is on screen.
//   setViewport                  CDP Emulation.setDeviceMetricsOverride, the
//                                only way to resize the guest's layout viewport
//                                without resizing the panel the user is using.
//   frames                       cross-origin iframes are unreachable from the
//                                top frame's executeJavaScript; the frame tree
//                                (webContents.mainFrame.framesInSubtree) is the
//                                only route to them.
//   downloads                    session 'will-download' is a main-process event.
//   clipboard                    the Electron clipboard module is main-only.
//
// Every op re-uses the WEBVIEW_SCREENSHOT ownership rule: the target
// webContents must be a webview guest hosted by the CALLING window, so one
// window can never reach into another's pages.
// =============================================================================

import { app, BrowserWindow, clipboard, ipcMain, webContents, type WebContents } from 'electron'
import fs from 'fs'
import path from 'path'
import log from '../logger'
import { wrapHandler } from './handlerError'
import { grantFileAccess } from './pathValidation'
import { BROWSER_CONTROL } from '../../shared/ipc-channels'
import {
  registerPlaywrightBrowserTarget,
  runPlaywrightBrowserAction,
  type PlaywrightBrowserAction,
} from '../browser/playwrightBrowser'
import { dispatchBrowserInput, type BrowserInputRequest } from '../browser/guestInput'
import { flattenScreenshotPng } from '../browser/screenshotPng'
import { captureFullPageScreenshot } from '../browser/fullPageScreenshot'

export interface BrowserControlRequest {
  op:
    | 'screenshot'
    | 'setViewport'
    | 'frames'
    | 'frameEval'
    | 'downloads'
    | 'clipboardRead'
    | 'clipboardWrite'
    | 'registerPlaywright'
    | 'playwright'
    | 'input'
  webContentsId: number
  /** screenshot: which region to capture. */
  mode?: 'viewport' | 'fullPage' | 'rect'
  rect?: { x: number; y: number; width: number; height: number }
  /** setViewport: null/omitted clears the override. */
  viewport?: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean } | null
  /** frameEval: which frame, and what to run in it. */
  frameRoutingId?: number
  frameProcessId?: number
  code?: string
  /** clipboardWrite: the text to place on the system clipboard. */
  text?: string
  /** registerPlaywright: stable renderer-owned browser identities. */
  panelId?: string
  tabId?: string
  /** playwright: semantic action and its snapshot refs/options. */
  action?: PlaywrightBrowserAction
  ref?: string
  targetRef?: string
  key?: string
  values?: string[]
  button?: 'left' | 'right' | 'middle'
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
  delay?: number
  /** input: trusted keyboard events delivered to the focused guest target. */
  input?: BrowserInputRequest['input']
}

/** Resolve the target guest, enforcing that it belongs to the calling window. */
export function resolveBrowserGuest(event: Electron.IpcMainInvokeEvent, webContentsId: number): WebContents | null {
  const wc = webContents.fromId(webContentsId)
  if (!wc || wc.isDestroyed()) return null
  const callerWin = BrowserWindow.fromWebContents(event.sender)
  const targetWin = BrowserWindow.fromWebContents(wc)
  if (!callerWin || !targetWin || targetWin.id !== callerWin.id) {
    const hostWc = wc.hostWebContents
    if (!hostWc || hostWc.id !== event.sender.id) {
      log.warn(`[browser:control] denied: webContentsId ${webContentsId} is not owned by the calling window`)
      return null
    }
  }
  return wc
}

/** CDP attach is per-webContents and throws if something else already holds it
 *  (DevTools). Attach lazily, and never detach a session we did not open. */
function withDebugger<T>(wc: WebContents, run: () => Promise<T>): Promise<T> {
  let attachedHere = false
  if (!wc.debugger.isAttached()) {
    wc.debugger.attach('1.3')
    attachedHere = true
  }
  return run().finally(() => {
    if (attachedHere && wc.debugger.isAttached()) {
      try { wc.debugger.detach() } catch { /* already gone */ }
    }
  })
}

async function writePng(bytes: Buffer, callerWinId: number | undefined): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = path.join(app.getPath('temp'), 'cate-screenshots')
  await fs.promises.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `screenshot-${timestamp}.png`)
  await fs.promises.writeFile(filePath, await flattenScreenshotPng(bytes))
  if (callerWinId !== undefined) await grantFileAccess(callerWinId, filePath)
  return filePath
}

// Downloads observed per guest webContents, newest last. `wait download` reads
// this; it is capped because nothing ever prunes it otherwise.
const DOWNLOADS_PER_GUEST = 20
const downloadsByWebContents = new Map<number, Array<{ url: string; filePath: string; state: string; at: number }>>()

/** Record downloads for a guest's session. Called by the browser panel host when
 *  a partition is first configured, so a download that happens before any agent
 *  asks about it is still observed. Safe to call repeatedly for one session. */
const watchedSessions = new WeakSet<Electron.Session>()
export function watchDownloadsForSession(session: Electron.Session): void {
  if (watchedSessions.has(session)) return
  watchedSessions.add(session)
  session.on('will-download', (_event, item, guest) => {
    const id = guest?.id
    if (id === undefined) return
    const list = downloadsByWebContents.get(id) ?? []
    const entry = { url: item.getURL(), filePath: '', state: 'started', at: Date.now() }
    list.push(entry)
    while (list.length > DOWNLOADS_PER_GUEST) list.shift()
    downloadsByWebContents.set(id, list)
    item.once('done', (_e, state) => {
      entry.state = state
      entry.filePath = item.getSavePath()
    })
  })
}

export function registerBrowserControlHandlers(): void {
  ipcMain.handle(BROWSER_CONTROL, wrapHandler(`[${BROWSER_CONTROL}]`, async (event, req: BrowserControlRequest) => {
    // Clipboard is app-global, but still gated on owning a real guest so the
    // permission story stays "you may drive THIS panel".
    const wc = resolveBrowserGuest(event, req.webContentsId)
    if (!wc) return { error: 'no-guest' }
    const callerWinId = BrowserWindow.fromWebContents(event.sender)?.id

    switch (req.op) {
      case 'screenshot': {
        if (req.mode === 'rect' && req.rect) {
          const image = await wc.capturePage(req.rect)
          if (image.isEmpty()) return { error: 'capture-empty' }
          return { filePath: await writePng(image.toPNG(), callerWinId) }
        }
        if (req.mode === 'fullPage') {
          const png = await withDebugger(wc, () => captureFullPageScreenshot(wc))
          return { filePath: await writePng(png, callerWinId) }
        }
        const image = await wc.capturePage()
        if (image.isEmpty()) return { error: 'capture-empty' }
        return { filePath: await writePng(image.toPNG(), callerWinId) }
      }

      case 'setViewport': {
        return withDebugger(wc, async () => {
          if (!req.viewport) {
            await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')
            return { ok: true, cleared: true }
          }
          const { width, height, deviceScaleFactor = 0, mobile = false } = req.viewport
          await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
            width, height, deviceScaleFactor, mobile,
          })
          return { ok: true, width, height }
        })
      }

      case 'frames': {
        // routingId + processId together address a frame uniquely across
        // process boundaries (a cross-origin iframe lives in its own renderer).
        return {
          frames: wc.mainFrame.framesInSubtree.map((frame) => ({
            routingId: frame.routingId,
            processId: frame.processId,
            url: frame.url,
            name: frame.name,
            top: frame === wc.mainFrame,
          })),
        }
      }

      case 'frameEval': {
        const frame = wc.mainFrame.framesInSubtree.find(
          (f) => f.routingId === req.frameRoutingId && f.processId === req.frameProcessId,
        )
        if (!frame) return { error: 'no-such-frame' }
        try {
          return { value: await frame.executeJavaScript(req.code ?? '', true) }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'frame-eval-failed' }
        }
      }

      case 'downloads':
        return { downloads: downloadsByWebContents.get(req.webContentsId) ?? [] }

      case 'clipboardRead':
        return { text: clipboard.readText() }

      case 'clipboardWrite':
        clipboard.writeText(req.text ?? '')
        return { ok: true }

      case 'registerPlaywright': {
        if (!req.panelId || !req.tabId) return { error: 'browser-target-required' }
        await registerPlaywrightBrowserTarget(wc, req.panelId, req.tabId)
        return { ok: true }
      }

      case 'playwright':
        if (!req.action) return { error: 'playwright-action-required' }
        return runPlaywrightBrowserAction(req.webContentsId, {
          action: req.action,
          ref: req.ref,
          targetRef: req.targetRef,
          text: req.text,
          key: req.key,
          values: req.values,
          button: req.button,
          modifiers: req.modifiers,
          delay: req.delay,
        })

      case 'input':
        if (req.input !== 'insertText' && req.input !== 'replaceText' && req.input !== 'key') {
          return { error: 'browser-input-required' }
        }
        await dispatchBrowserInput(wc, req.input === 'key'
          ? { input: 'key', key: req.key, modifiers: req.modifiers }
          : { input: req.input, text: req.text, delay: req.delay })
        return { ok: true }

      default:
        return { error: 'unsupported-op' }
    }
  }))
}
