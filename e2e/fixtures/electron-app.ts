// E2E fixture: launch the built desktop shell (`dist/main/shell.js`) with an
// isolated device and home.
//
// - HOME is a temp dir with a SHORT path (`/tmp/ce-XXXX`): the runtime's Unix
//   socket lives at `$HOME/.cate/workspaces/<runtimeId>/runtime.sock` and
//   socket paths are limited to ~104 bytes on macOS.
// - `CATE_E2E_USER_DATA` is the device's userData (device key, settings,
//   workspace list). Two clients on one machine share HOME (so the same
//   runtime) and differ in userData.
// - `CATE_RUNTIME_BUNDLE` makes the shell start `dist-runtime/runtime.cjs`
//   with this Node instead of installing the runtime tarball.
// - CATE_E2E=1 installs `window.__cateE2E` (src/client/ui/e2e/e2eHarness.ts).
//
// Runtimes are detached daemons that outlive the app; `closeApp` stops the
// ones under the test's HOME.

import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { expect } from '@playwright/test'
// Types `window.__cateE2E` (the harness declares it globally).
import type {} from '../../src/shells/desktop/ui/app/e2e/e2eHarness'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'

export interface LaunchResult {
  electronApp: ElectronApplication
  mainWindow: Page
  home: string
  userDataDir: string
  /** The opened workspace (unless `workspace: false`). */
  workspaceId: string | null
  project: string | null
}

export const REPO_ROOT = path.resolve(__dirname, '..', '..')
export const RUNTIME_BUNDLE = path.join(REPO_ROOT, 'dist-runtime', 'runtime.cjs')

/** A fresh, short HOME for one test (see the note on socket paths). */
export function makeHome(): string {
  return mkdtempSync('/tmp/ce-')
}

/** A project folder under `home`, optionally a git repo with one commit.
 *  Returns its real path: the runtime's root is canonical (`/private/tmp` on
 *  macOS) and it refuses paths spelled through the `/tmp` alias. */
export function makeProject(home: string, opts: { name?: string; git?: boolean; files?: Record<string, string> } = {}): string {
  const dir = path.join(home, opts.name ?? 'proj')
  mkdirSync(dir, { recursive: true })
  for (const [file, text] of Object.entries(opts.files ?? {})) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), text)
  }
  if (opts.git) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    git('init', '-q', '-b', 'trunk')
    git('-c', 'user.email=e2e@cate.test', '-c', 'user.name=e2e', 'commit', '-q', '--allow-empty', '-m', 'init')
  }
  return realpathSync(dir)
}

/**
 * A runtime install layout (`<dir>/runtime/bin/node`, `<dir>/t3/dist/bin.mjs`)
 * whose T3 harness is the deterministic fake in `fake-t3.cjs`. The daemon
 * finds its install from its Node's path, so this Node is a hard link (or a
 * copy) of the test's own. Returns the Node to pass as `CATE_RUNTIME_NODE`.
 */
export function fakeRuntimeInstall(home: string): string {
  const dir = path.join(home, 'rt')
  const node = path.join(dir, 'runtime', 'bin', 'node')
  if (existsSync(node)) return node
  mkdirSync(path.dirname(node), { recursive: true })
  try { linkSync(process.execPath, node) } catch { copyFileSync(process.execPath, node) }
  // A Node that loads libnode from `../lib` (Homebrew) needs it next to the link.
  const lib = path.join(path.dirname(process.execPath), '..', 'lib')
  if (existsSync(lib)) symlinkSync(realpathSync(lib), path.join(dir, 'runtime', 'lib'))
  const t3 = path.join(dir, 't3', 'dist', 'bin.mjs')
  mkdirSync(path.dirname(t3), { recursive: true })
  const fake = path.join(__dirname, 'fake-t3.cjs')
  writeFileSync(t3, `import { createRequire } from 'node:module'\ncreateRequire(import.meta.url)(${JSON.stringify(fake)})\n`)
  return node
}

export interface LaunchOptions {
  /** Defaults to a new temp HOME. */
  home?: string
  /** Defaults to `<home>/ud-<n>`. */
  userDataDir?: string
  /** Show the first-run welcome and tour (a fresh userData only). Default false. */
  firstRun?: boolean
  /** A folder to open, `true` for a new empty project, `false` for none. Default true. */
  workspace?: string | boolean
  /** Put a canvas panel in the main window (default true when a workspace opens). */
  canvas?: boolean
  perf?: boolean
  /** Terminals render with xterm's DOM renderer, so their text is in the DOM. */
  domTerminals?: boolean
  /** Run the runtime from `fakeRuntimeInstall(home)`, so T3 is the fake harness. */
  fakeT3?: boolean
  env?: Record<string, string>
}

let userDataCounter = 0
/** The HOME each app was launched with, so `closeApp(app)` can clean up. */
const homes = new WeakMap<ElectronApplication, string>()

export async function launchApp(opts: LaunchOptions = {}): Promise<LaunchResult> {
  const home = opts.home ?? makeHome()
  const userDataDir = opts.userDataDir ?? path.join(home, `ud-${++userDataCounter}`)
  if (!opts.firstRun && !existsSync(path.join(userDataDir, 'ui-state.json'))) {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(path.join(userDataDir, 'ui-state.json'), JSON.stringify({ telemetryNoticeAcknowledgedVersion: 99, onboardingCompleted: true }))
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CATE_E2E: '1',
    NODE_ENV: 'production',
    CATE_E2E_USER_DATA: userDataDir,
    CATE_RUNTIME_BUNDLE: RUNTIME_BUNDLE,
    CATE_RUNTIME_NODE: opts.fakeT3 ? fakeRuntimeInstall(home) : process.execPath,
    ...(opts.perf ? { CATE_PERF: '1' } : {}),
    ...opts.env,
  }
  // Playwright forces colored output while some hosts export NO_COLOR; both in
  // a real terminal make every Node CLI print a warning.
  delete env.NO_COLOR
  const electronApp = await electron.launch({
    // Reproduce packaged-only failures with the released app and engine while
    // retaining this fixture's isolated profile and runtime.
    executablePath: process.env.CATE_E2E_EXECUTABLE,
    args: [process.env.CATE_E2E_APP_PATH ?? '.'],
    cwd: REPO_ROOT,
    env,
  })
  if (!opts.home) homes.set(electronApp, home)
  const mainWindow = await electronApp.firstWindow()
  await mainWindow.waitForLoadState('domcontentloaded')
  await mainWindow.waitForFunction(() => window.__cateE2E?.ready === true, null, { timeout: 45_000 })
  await dismissFirstRun(mainWindow)
  if (opts.domTerminals) await forceDomTerminals(mainWindow)

  let workspaceId: string | null = null
  let project: string | null = null
  if (opts.workspace !== false) {
    project = typeof opts.workspace === 'string' ? opts.workspace : makeProject(home)
    workspaceId = await openWorkspace(mainWindow, project)
    if (opts.canvas !== false) await addCanvas(mainWindow)
  }
  return { electronApp, mainWindow, home, userDataDir, workspaceId, project }
}

/** Refuses WebGL2 contexts in this window, so xterm stays on its DOM
 *  renderer and terminal text is readable from the DOM. Affects views
 *  created afterwards (and the canvas territory layer). */
export async function forceDomTerminals(page: Page): Promise<void> {
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (type === 'webgl2') return null
      return (original as (...args: unknown[]) => unknown).call(this, type, ...rest)
    } as typeof original
  })
}

/** Clicks through the first-run welcome dialog when it shows. */
export async function dismissFirstRun(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'Continue', exact: true })
  if (await button.isVisible({ timeout: 1500 }).catch(() => false)) await button.click()
}

/** Adds `dir` as a local workspace, answers the trust question, and waits
 *  until its document arrived. Returns the workspace id. */
export async function openWorkspace(page: Page, dir: string): Promise<string> {
  let done = false
  const opened = page.evaluate((root) => window.__cateE2E!.addWorkspace(undefined, root), dir)
    .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
    .then((result) => { done = true; return result })
  const trust = page.getByRole('button', { name: 'Trust and open' })
  await expect.poll(async () => done || await trust.isVisible(), { timeout: 30_000, message: 'workspace opens or asks for trust' }).toBe(true)
  if (!done) await trust.click({ noWaitAfter: true })
  const result = await opened
  if (!result.ok) throw result.error
  const id = result.value
  await page.waitForFunction((ws) => !!window.__cateE2E!.document(ws), id, { timeout: 30_000 })
  return id
}

/** A canvas panel in the main window, mounted. Returns its panel id. */
export async function addCanvas(page: Page): Promise<string> {
  const existing = await page.evaluate(() => window.__cateE2E!.activeCanvasPanelId())
  if (existing) return existing
  await page.evaluate(() => window.__cateE2E!.createPanel('canvas'))
  await page.waitForSelector('[data-canvas-container]', { timeout: 15_000 })
  await page.waitForFunction(() => !!window.__cateE2E!.activeCanvasPanelId())
  return (await page.evaluate(() => window.__cateE2E!.activeCanvasPanelId()))!
}

/** Stops every runtime whose data lives under `home`. */
export function stopRuntimes(home: string): void {
  const dir = path.join(home, '.cate', 'workspaces')
  if (!existsSync(dir)) return
  for (const id of readdirSync(dir)) {
    try {
      const info = JSON.parse(readFileSync(path.join(dir, id, 'runtime.json'), 'utf8')) as { pid?: number }
      if (info.pid) process.kill(info.pid, 'SIGKILL')
    } catch { /* not running */ }
  }
}

/** Closes the app. The HOME launchApp made itself is cleaned up with it; pass
 *  `home` to clean up one the test made (after its last app closed). */
export async function closeApp(electronApp: ElectronApplication | undefined, opts: { home?: string; keepRuntimes?: boolean; removeHome?: boolean } = {}): Promise<void> {
  if (electronApp && !opts.home) {
    const own = homes.get(electronApp)
    if (own) opts = { ...opts, home: own }
  }
  if (electronApp) {
    const child = electronApp.process()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        electronApp.close(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Electron close timed out')), 10_000) }),
      ])
    } catch {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  if (opts.home && !opts.keepRuntimes) {
    stopRuntimes(opts.home)
    // The killed runtime's shells get SIGHUP and still write into HOME
    // (.zsh_history) while it is removed. The async rm retries on ENOTEMPTY;
    // rmSync ignores maxRetries on Node 22.
    if (opts.removeHome !== false && !process.env.E2E_KEEP_HOME) await rm(opts.home, { recursive: true, force: true, maxRetries: 10 })
  }
}

// -----------------------------------------------------------------------------
// Panels
// -----------------------------------------------------------------------------

/** Creates a panel as a canvas node at `origin`; resolves once its node is in the DOM. */
export async function seedOnCanvas(page: Page, type: string, origin = { x: 200, y: 200 }, options: Record<string, unknown> = {}): Promise<{ panelId: string; nodeId: string }> {
  const created = await page.evaluate(({ type, origin, options }) => window.__cateE2E!.createOnCanvas(type, origin, options), { type, origin, options })
  if (!created) throw new Error(`could not create ${type} on the canvas`)
  await page.waitForSelector(`[data-node-id="${created.nodeId}"]`, { timeout: 15_000 })
  return created
}

export async function seedTerminal(page: Page, origin = { x: 200, y: 200 }): Promise<string> {
  const { nodeId } = await seedOnCanvas(page, 'terminal', origin)
  // Let the entering animation settle.
  await page.waitForTimeout(300)
  return nodeId
}

export async function seedEditor(page: Page, origin = { x: 200, y: 200 }): Promise<string> {
  return (await seedOnCanvas(page, 'editor', origin)).nodeId
}

/** Polls the runtime's screen of a terminal panel until it contains `text`. */
export async function expectTerminalText(page: Page, panelId: string, text: string | RegExp, opts: { workspaceId?: string; timeout?: number } = {}): Promise<void> {
  await expect.poll(
    () => page.evaluate(({ panelId, ws }) => window.__cateE2E!.terminalText(panelId, ws ?? undefined), { panelId, ws: opts.workspaceId ?? null }).catch(() => ''),
    { timeout: opts.timeout ?? 20_000, message: `terminal ${panelId} shows ${text}` },
  ).toMatch(text)
}

// -----------------------------------------------------------------------------
// Canvas helpers
// -----------------------------------------------------------------------------

export async function dragMouse(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { steps?: number; holdDownMs?: number; pauseAtEnd?: number } = {},
): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  if (opts.holdDownMs) await page.waitForTimeout(opts.holdDownMs)
  await page.mouse.move(to.x, to.y, { steps: opts.steps ?? 20 })
  if (opts.pauseAtEnd) await page.waitForTimeout(opts.pauseAtEnd)
  await page.mouse.up()
}

export async function getNodeRect(page: Page, nodeId: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const handle = await page.$(`[data-node-id="${nodeId}"]`)
  return handle ? handle.boundingBox() : null
}

export async function getNodeOrigin(page: Page, nodeId: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((id) => window.__cateE2E?.nodes().find((x) => x.id === id)?.origin ?? null, nodeId)
}

export async function setZoom(page: Page, zoom: number): Promise<void> {
  await page.evaluate((z) => window.__cateE2E!.setZoom(z), zoom)
  await page.waitForTimeout(80)
}

export async function resetViewport(page: Page): Promise<void> {
  await page.evaluate(() => window.__cateE2E!.resetViewport())
  await page.waitForTimeout(30)
}

/** A point inside the node's first tab, where a title-bar drag starts. */
export async function titleBarCentre(page: Page, nodeId: string): Promise<{ x: number; y: number } | null> {
  const tab = await page.$(`[data-node-id="${nodeId}"] [data-tab-panel-id]`)
  const box = tab ? await tab.boundingBox() : null
  if (box) return { x: box.x + Math.min(40, box.width / 2), y: box.y + box.height / 2 }
  const rect = await getNodeRect(page, nodeId)
  return rect ? { x: rect.x + 40, y: rect.y + 6 } : null
}

export async function waitForGhost(page: Page, timeout = 8000): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    const handle = await page.waitForSelector('[data-drag-overlay-ghost="true"]', { state: 'attached', timeout })
    return handle.boundingBox()
  } catch {
    return null
  }
}

// -----------------------------------------------------------------------------
// Webview guests
// -----------------------------------------------------------------------------

/** Runs `expression` in the first webview guest whose URL starts with
 *  `urlPrefix` (an oracle from main, not the browser panel's own API). */
export async function guestEvaluate(app: ElectronApplication, urlPrefix: string, expression: string): Promise<unknown> {
  return app.evaluate(async ({ webContents }, { urlPrefix, expression }) => {
    const guest = webContents.getAllWebContents().find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith(urlPrefix))
    if (!guest) throw new Error(`no guest at ${urlPrefix}`)
    return guest.executeJavaScript(expression)
  }, { urlPrefix, expression })
}

export async function guestUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((wc) => wc.getType() === 'webview').map((wc) => wc.getURL()))
}

/** Answers every native message box of `app` (confirmations) with button
 *  `response` (0: the first, "OK"), so flows that confirm can run headless. */
export async function answerDialogs(app: ElectronApplication, response = 0): Promise<void> {
  await app.evaluate(({ dialog }, response) => {
    dialog.showMessageBox = (async () => ({ response, checkboxChecked: false })) as typeof dialog.showMessageBox
  }, response)
}
