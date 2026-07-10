import log from './logger'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import path from 'path'
import { registerHandlers as registerTerminalHandlers } from './ipc/terminal'
import { runtimes } from './runtime/runtimeManager'
import { registerRuntimeHandlers } from './ipc/runtime'
import { registerExtensionHandlers } from './extensions/cateApiHandlers'
import { registerHandlers as registerFilesystemHandlers } from './ipc/filesystem'
import { registerHandlers as registerGitHandlers } from './ipc/git'
import { registerHandlers as registerSearchHandlers } from './ipc/search'
import { registerHandlers as registerShellHandlers } from './ipc/shell'
import { registerHandlers as registerGitMonitorHandlers } from './ipc/git-monitor'
import { registerHandlers as registerStoreHandlers, loadSettingsSyncFromDisk, getSettingSync, setSettingsFromMain } from './store'
import { registerUIStateHandlers } from './uiStateStore'
import { registerProjectStateHandlers } from './projectWorkspaceStore'
import { registerProjectCateAgentHandlers } from './projectCateAgentStore'
import { registerProjectChatsHandlers } from './projectChatsStore'
import { registerHandlers as registerMenuHandlers } from './ipc/menu'
import { registerHandlers as registerNotificationHandlers } from './ipc/notifications'
import { registerAgentHandlers } from '../agent/main/ipcAgent'
import { registerSkillHandlers } from '../skills/main/ipcSkills'
import { registerAuthHandlers } from '../agent/main/ipcAuth'
import { authManager } from '../agent/main/authManager'
// Shared singletons for pi agent + auth (constructed at module load).
import { agentManager } from '../agent/main/agentManager'
import { registerWorkspaceHandlers } from './workspaceManager'
import { buildApplicationMenu, setNewMainWindowFn } from './menu'
import { initShellEnv, getShellEnv } from './shellEnv'
import { currentExclusionSet } from './ipc/filesystem'
import { initAutoUpdater } from './auto-updater'
import { initSentry, captureMainException, flushSentry } from './sentry'
import { initAnalytics, devSimulateUpdateFrom, hasRunBefore } from './analytics'
import { startPerfMonitor, getLatestSnapshot } from './perf/perfMonitor'
import { PERF_GET } from '../shared/ipc-channels'
import { TELEMETRY_NOTICE_VERSION } from '../shared/types'
import { installWebContentsSecurity } from './webSecurity'
import { installProxyAuthHandler } from './browserProxy'
import { installBundledSkill } from './installBundledSkill'

import { createWindow } from './windows/windowFactory'
import { IS_E2E } from './windows/reveal'
import { registerDialogHandlers } from './ipc/dialogs'
import { registerCaptureHandlers } from './ipc/capture'
import { registerWindowControlHandlers } from './ipc/windowControls'
import { registerDockWindowHandlers } from './ipc/dockWindows'
import { registerWindowPanelHandlers } from './ipc/windowPanels'
import { registerDragHandlers } from './ipc/dragHandlers'
import { setMainWindowReady, flushPendingOpenPaths, registerOpenFileHandler } from './lifecycle/openPath'
import { fireStartupTelemetry, registerTelemetryNoticeHandler } from './lifecycle/telemetry'
import { registerLifecycleHandlers } from './lifecycle/shutdown'

// NOTE: runSmokeAssertions only ever runs when CATE_SMOKE_TEST=1. The 1200 ms
// wait below is part of the smoke-only branch in mainWin.once('ready-to-show')
// and never executes on normal launches. Do not re-introduce it on the hot path.
async function runSmokeAssertions(win: BrowserWindow): Promise<void> {
  const result = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          hasElectronAPI: typeof window.electronAPI === 'object',
          hasFullscreenCheck: typeof window.electronAPI?.isMainWindowFullscreen === 'function',
        })
      }, 1200)
    })
  `, true) as { hasElectronAPI?: boolean; hasFullscreenCheck?: boolean }

  if (!result?.hasElectronAPI || !result?.hasFullscreenCheck) {
    throw new Error('Smoke test failed: preload bridge did not initialize correctly')
  }
}

// =============================================================================
// Register all IPC handlers ONCE (not per-window)
// =============================================================================

/**
 * Critical-path IPC handlers — registered synchronously before the first
 * BrowserWindow is created. These are everything the renderer might call
 * during settings load, session restore, and the first paint.
 *
 * Terminal + shell handlers are in the critical set because terminal:create
 * can fire as soon as the session restore reaches a terminal node, which can
 * happen before `ready-to-show`. Pushing them to the deferred set caused
 * "no handler registered" errors in practice.
 */
function registerCriticalHandlers(): void {
  registerStoreHandlers()
  registerUIStateHandlers()
  registerProjectStateHandlers()
  registerProjectCateAgentHandlers()
  registerProjectChatsHandlers()
  registerWorkspaceHandlers()
  registerFilesystemHandlers()
  registerTerminalHandlers()
  registerShellHandlers()
  registerMenuHandlers()
  // Window, dialog, panel-transfer, dock, and drag IPC. Split into focused
  // modules; the panel/dock/drag handlers need the window factory injected.
  registerDialogHandlers()
  registerCaptureHandlers()
  registerWindowControlHandlers()
  registerDockWindowHandlers({ createWindow })
  registerWindowPanelHandlers()
  registerDragHandlers({ createWindow })
  // Resource profiler — no-op unless CATE_PERF=1.
  startPerfMonitor()
  ipcMain.handle(PERF_GET, () => getLatestSnapshot())
}

/**
 * Background IPC handlers — registered after the first paint inside
 * mainWin.once('ready-to-show'). Nothing on the critical render path
 * should depend on these.
 */
function registerDeferredHandlers(): void {
  registerGitHandlers()
  registerSearchHandlers()
  registerGitMonitorHandlers()
  registerNotificationHandlers()
  registerAuthHandlers(authManager)
  registerAgentHandlers(authManager, agentManager)
  registerSkillHandlers()
  registerRuntimeHandlers()
  registerExtensionHandlers()
}

// =============================================================================
// App lifecycle / bootstrap
// =============================================================================

// Set app name before menu and window creation
app.setName('Cate')

// Windows: the toast notification system keys off the AppUserModelID, and it
// must match the install shortcut's ID (electron-builder uses `appId`) for the
// notification 'click' event to fire reliably. No-op on macOS/Linux.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.cate.app')
}

// In dev mode, use a separate userData directory so dev and production don't collide
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('userData'), 'Dev'))
}

// First-start simulation (`npm run dev:firststart`). Point userData at a
// dedicated dir that's wiped on every launch, so the app boots exactly like a
// brand-new install: telemetry notice + onboarding tour, empty session, no
// recent projects or saved window geometry. Dev-only; never in a packaged app.
if (!app.isPackaged && process.env.CATE_FRESH_USERDATA === '1') {
  const fs = require('fs') as typeof import('fs')
  const dir = path.join(app.getPath('userData'), 'FirstStart')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  fs.mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)
  log.info('[firststart] fresh userData (wiped on each launch): %s', dir)
}

// Dev-only: simulate launching right after an update at a given level
// (major / minor / patch). Uses its own wiped userData dir, then seeds the
// analytics state so `checkAndReportUpdate` sees a version bump from a synthetic
// previous version. The grandfather block below marks it as an existing
// (already-onboarded) user, so the onboarding tour stays hidden — but the
// telemetry notice still appears, because the simulated profile hasn't
// acknowledged the current TELEMETRY_NOTICE_VERSION (exactly like a real user
// updating into this release). On major/minor bumps the post-update feedback
// dialog appears alongside it; a patch bump shows the notice only. See dev:update:*.
if (!app.isPackaged && (process.env.CATE_SIMULATE_UPDATE === 'major' || process.env.CATE_SIMULATE_UPDATE === 'minor' || process.env.CATE_SIMULATE_UPDATE === 'patch')) {
  const level = process.env.CATE_SIMULATE_UPDATE
  const fs = require('fs') as typeof import('fs')
  const dir = path.join(app.getPath('userData'), `SimUpdate-${level}`)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  fs.mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)
  const from = devSimulateUpdateFrom(level)
  log.info('[sim-update] %s: simulating update %s → %s (userData: %s)', level, from, app.getVersion(), dir)
}

// In E2E mode, use a fresh tmpdir per launch so Playwright runs are isolated
// from each other and from local dev state. The harness sets CATE_E2E=1.
if (process.env.CATE_E2E === '1') {
  // The e2e window is never shown, so Chromium throttles it. Per-window
  // backgroundThrottling:false isn't enough on Windows: its native occlusion
  // detection marks a never-mapped window as occluded and freezes the
  // compositor — and with it the rAF loop that applies node-drag transforms —
  // so every drag spec times out on the Windows runner while no-op specs pass.
  // These switches (no-ops on macOS/Linux, where the symptom doesn't occur)
  // disable that occlusion freeze and renderer/timer backgrounding. Must run
  // before app-ready, which this module-level block does.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')

  const fs = require('fs') as typeof import('fs')
  const os = require('os') as typeof import('os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-e2e-'))
  app.setPath('userData', tmp)
  // Keep the e2e app out of the macOS dock / app-switcher so launching it never
  // foregrounds the shared Electron bundle (and a running `npm run dev`).
  app.dock?.hide()
}

// Register the macOS open-file handler at top level: the event can fire before
// app-ready, so we must be listening early to queue paths into pendingOpenPaths.
registerOpenFileHandler()

// Build application menu
buildApplicationMenu()

log.info('Cate v%s starting (electron %s, node %s, platform %s)', app.getVersion(), process.versions.electron, process.versions.node, process.platform)

// Load persisted settings synchronously so window-creation code paths can read
// them before the async electron-store finishes initializing.
loadSettingsSyncFromDisk()

// Optional GPU-rasterization workaround (off by default). Under this app's GPU
// load — many live xterm WebGL contexts + the worktree-territory WebGL2 renderer
// + the canvas's `will-change: transform` compositing churn — Chromium's shared
// GPU glyph atlas can intermittently corrupt, repainting text with random
// missing glyphs (most visible in the file tree). Moving rasterization to the
// CPU removes the glyph atlas from the path; WebGL still renders and composites
// on the GPU, so terminals/territory stay accelerated. Command-line switches
// must be set before app-ready (this runs at module load), so the toggle only
// takes effect after a restart.
if (getSettingSync('disableGpuRasterization')) {
  app.commandLine.appendSwitch('disable-gpu-rasterization')
  log.info('[gpu] GPU rasterization disabled via setting (text rendered on CPU)')
}

// Scope the onboarding tour to genuine first installs. Anyone who has launched
// Cate before is marked past it, so an update never replays the tour. The
// telemetry notice (WelcomeDialog) intentionally has NO such clause — every
// user whose acknowledged notice version is below TELEMETRY_NOTICE_VERSION
// sees it once, updaters included.
if (hasRunBefore()) {
  if (!getSettingSync('onboardingCompleted')) {
    void setSettingsFromMain({ onboardingCompleted: true })
  }
}

// Under Playwright the profile is a fresh tmpdir, which would otherwise trigger
// the telemetry notice + onboarding takeover and cover the canvas the specs
// drive. Mark both as already handled so e2e starts on a clean canvas. Runs
// before the renderer queries settings, so the dialogs never flash.
if (IS_E2E) {
  void setSettingsFromMain({ telemetryNoticeAcknowledgedVersion: TELEMETRY_NOTICE_VERSION, onboardingCompleted: true })
}

// Initialize Sentry as early as possible — before any IPC handlers or windows.
// Always on in packaged builds; no-op in dev unless SENTRY_DSN is set.
initSentry()
initAnalytics()

// Telemetry-notice acknowledgement from the renderer (WelcomeDialog).
registerTelemetryNoticeHandler()

// Provide the menu module a way to spawn additional main windows without
// importing this file (which would create a circular dependency).
setNewMainWindowFn(() => createWindow({ type: 'main' }))

// ---------------------------------------------------------------------------
// Crash / signal teardown. Local terminals run in the runtime daemon
// subprocess: when this main process dies its stdin closes, and the daemon's
// `process.stdin.on('close')` handler (src/runtime/index.ts) group-kills its
// ptys and exits — so dev servers/watchers don't survive as zombies. No
// in-process PTY cleanup is needed here anymore.
// ---------------------------------------------------------------------------

// Global error handlers — Sentry (when configured) captures the error before
// process exit.
process.on('uncaughtException', (err) => {
  log.error('uncaughtException: %O', err)
  captureMainException(err)
  flushSentry().finally(() => process.exit(1))
})
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection: %O', reason)
  captureMainException(reason)
})

process.on('SIGTERM', () => {
  log.info('Received SIGTERM, exiting')
  process.exit(0)
})

process.on('SIGINT', () => {
  log.info('Received SIGINT, exiting')
  process.exit(0)
})

app.whenReady().then(async () => {
  // Phase 0 perf marker — log a high-resolution timestamp at app.whenReady
  // so cold-launch traces can be reconstructed from main + renderer logs.
  log.info('[perf] app.whenReady t=%dms', Math.round(performance.now()))
  log.info('App ready, resolving shell environment...')

  // Resolve the user's real shell environment before registering handlers.
  // This ensures MCP servers, `which` lookups, etc. see the full PATH.
  await initShellEnv()
  log.info('Shell environment resolved')

  // Bring the local workspace online: provision + launch the host-target runtime
  // tarball as a local daemon, the same path remote hosts use. Done after the shell
  // env so the daemon inherits the full PATH for git/terminals. This registers a
  // DeferredRuntime SYNCHRONOUSLY (resolve(LOCAL) works immediately) and connects
  // the daemon in the background, so first-run tarball provisioning never blocks
  // the window paint — early IPC ops queue behind the deferred's `ready`.
  runtimes.ensureLocalRuntime({
    root: app.getPath('home'),
    exclusions: [...currentExclusionSet()],
    env: getShellEnv(),
    idleSuspend: getSettingSync('autoSuspendIdleTerminals'),
  })

  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: app.getName(),
      applicationVersion: app.getVersion(),
      version: app.getVersion(),
      copyright: `© ${new Date().getFullYear()} Cate`,
    })
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const origin = details.url
    if (origin.startsWith('file://') || (process.env.ELECTRON_RENDERER_URL && origin.startsWith(process.env.ELECTRON_RENDERER_URL))) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            `default-src 'self'; script-src 'self'${process.env.ELECTRON_RENDERER_URL ? " 'unsafe-inline' 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: file:; connect-src 'self' https: ws: wss: sentry-ipc:; font-src 'self' data:; base-uri 'self'`,
          ],
        },
      })
    } else {
      callback({})
    }
  })

  installWebContentsSecurity()
  installProxyAuthHandler()
  registerCriticalHandlers()
  log.info('Critical IPC handlers registered')

  // Install our first-party skills into ~/.claude/skills (copy-if-missing) so
  // Claude Code discovers them: cate-theme (theme authoring) and cate-cli
  // (teaches an agent in a Cate terminal how to use the `cate` CLI).
  void installBundledSkill('cate-theme')
  void installBundledSkill('cate-cli')

  const mainWin = createWindow({ type: 'main' })
  log.info('Main window created (id=%d)', mainWin.id)

  // Check for a crash report from the previous session — shows an opt-in
  // dialog if one exists. Deferred until the window is usable so the dialog has
  // a parent window and doesn't block startup. did-finish-load is a fallback
  // for hidden-window startup paths where ready-to-show never arrives.
  let mainWindowReadyHandled = false
  const markMainWindowReady = (reason: string): void => {
    if (mainWindowReadyHandled || mainWin.isDestroyed()) return
    mainWindowReadyHandled = true
    log.info('Main window ready via %s', reason)
    setMainWindowReady(true)
    flushPendingOpenPaths()
    // Register deferred IPC handlers and start the auto-updater now that the
    // first usable renderer load has landed. Anything not on the cold-launch
    // critical path belongs here.
    registerDeferredHandlers()
    log.info('Deferred IPC handlers registered')
    initAutoUpdater()
    // Detect a version change since last launch and emit an app_updated event
    // before app_start, so the upgrade path lands in analytics in order.
    fireStartupTelemetry(mainWin)
    if (process.env.CATE_SMOKE_TEST === '1') {
      runSmokeAssertions(mainWin)
        .then(() => app.exit(0))
        .catch((err) => {
          log.error('[smoke] %O', err)
          app.exit(1)
        })
    }
  }
  mainWin.once('ready-to-show', () => markMainWindowReady('ready-to-show'))
  mainWin.webContents.once('did-finish-load', () => markMainWindowReady('did-finish-load'))
})

// Window lifecycle: window-all-closed, activate, and the before-quit / will-quit
// / quit teardown sequence (session flush coordination, PTY teardown, locks).
registerLifecycleHandlers()
