// Launch environment: e2e mode, dev-only feature flags, userData isolation.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, type BrowserWindow } from 'electron'

/** Under Playwright windows are never shown (driven over CDP). */
export const IS_E2E = process.env.CATE_E2E === '1'

function devFlag(name: string): boolean {
  return !app.isPackaged && process.env[name] === '1'
}

export const featureFlags = {
  disableWebviewHardening: () => devFlag('CATE_DISABLE_WEBVIEW_HARDENING'),
  disableRendererSandbox: () => devFlag('CATE_DISABLE_RENDERER_SANDBOX'),
  perf: () => process.env.CATE_PERF === '1',
}

/** Shows a window, except under e2e where it stays unmapped so it never
 *  appears on screen or steals focus. */
export function revealWindow(win: BrowserWindow, options: { focus?: boolean } = {}): void {
  try {
    if (IS_E2E) return
    win.show()
    if (options.focus) win.focus()
  } catch { /* destroyed */ }
}

/** Picks the userData directory before anything reads it: `Dev/` for
 *  unpackaged builds, a wiped `FirstStart/` for `CATE_FRESH_USERDATA=1`, and a
 *  fresh temp dir per e2e launch. Must run before app ready. */
export function configureUserData(): string {
  if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('userData'), 'Dev'))
  if (!app.isPackaged && process.env.CATE_FRESH_USERDATA === '1') {
    const dir = path.join(app.getPath('userData'), 'FirstStart')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    app.setPath('userData', dir)
  }
  if (IS_E2E) {
    // A never-shown window counts as occluded on Windows, which freezes its
    // compositor; keep it and its timers running.
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
    app.commandLine.appendSwitch('disable-renderer-backgrounding')
    app.commandLine.appendSwitch('disable-background-timer-throttling')
    const requested = process.env.CATE_E2E_USER_DATA
    const dir = requested ? path.resolve(requested) : fs.mkdtempSync(path.join(os.tmpdir(), 'cate-e2e-'))
    fs.mkdirSync(dir, { recursive: true })
    app.setPath('userData', dir)
    process.env.CATE_E2E_USER_DATA = dir
    app.dock?.hide()
  }
  return app.getPath('userData')
}
