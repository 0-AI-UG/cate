// Desktop shell main process entry (architecture 15): windows, menus, native
// dialogs, the updater, analytics and crash reporting, the device files, the
// raw sockets for the client's transports, the loopback web proxies, the
// webview host and the client feature declaration. No workspace work runs
// here; that is the runtime's, reached by the renderer's connections.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, dialog, nativeTheme, net, session, shell } from 'electron'
import { autoUpdater as electronUpdater } from 'electron-updater'
import { createLogger, installLogSink } from '@kernel/log/contract'
import { createJsonStateFile } from '@kernel/state/node'
import { createElectronMainSink } from '@kernel/log/desktop/main'
import { clientSettingsTable, type ClientSettings } from '@kernel/settings/contract'
import { RUNTIME_BUILD, RUNTIME_VERSION } from '@runtime/daemon/contract'
import { createSshProvisioner, startLocalRuntime } from '@runtime/daemon/desktop'
import { isRuntimeInstalled } from '@runtime/daemon/node'
import { KnownRuntimes } from '@runtime/pairing/client'
import { createBrowserDesktop, flushPersistentSessions, installPersistentSessionTracking } from '@services/browser/desktop'
import { CANVAS_BACKGROUNDS_DIR, DESKTOP_CHANNELS as C, desktopClientFeatures, PRIVATE_DEVICE_FILES, type UpdateStatus } from '../contract'
import { ANALYTICS_ENDPOINT, createAnalytics, type CommonContext } from './analytics/analytics'
import { registerAppIpc } from './appIpc'
import { createCanvasBackgrounds } from './canvasBackgrounds'
import { registerCapture } from './capture'
import { createDeviceFiles } from './deviceFiles'
import { deviceStoreOf, registerDeviceIpc } from './deviceIpc'
import { configureUserData, featureFlags, IS_E2E, revealWindow } from './env'
import { createQuitController } from './lifecycle'
import { createAppMenu } from './menu'
import { registerNatives } from './natives'
import { createOpenRequests } from './openRequests'
import { startPerfMonitor } from './perf'
import { captureException, captureMessage, flushSentry, initSentry } from './sentry'
import { installThemeBootCache } from './themeBoot'
import { registerTransportIpc } from './transportIpc'
import { createShellTransportHost } from './transports'
import { canSelfUpdate, createAutoUpdater } from './updater/autoUpdater'
import { installBundledRuntime } from './updater/runtimeInstall'
import { registerSshIpc } from './sshIpc'
import { DEFAULT_UPDATE_RECORD, normalizeUpdateRecord } from './updater/updateState'
import { createWebPartitions } from './webPartitions'
import { installAppCsp, installWebSecurity } from './webSecurity'
import { createWindowFactory, shellPaths } from './windowFactory'
import { WindowRegistry } from './windowRegistry'

installLogSink(createElectronMainSink({ dev: !app.isPackaged }))
const log = createLogger('main')

app.setName('Cate')
// Windows toasts key their click events off the install shortcut's id.
if (process.platform === 'win32') app.setAppUserModelId('com.cate.app')

const userData = configureUserData()
const device = createDeviceFiles(userData)
const settings = (): ClientSettings => clientSettingsTable.normalize(device.get('settings'))

// Command-line switches must be set before ready; applies after a restart.
if (settings().disableGpuRasterization) app.commandLine.appendSwitch('disable-gpu-rasterization')

const context = (): CommonContext => ({
  install_id: device.installId(),
  app_version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  electron_version: process.versions.electron,
  node_version: process.versions.node,
  chrome_version: process.versions.chrome,
  locale: app.getLocale(),
  is_packaged: app.isPackaged,
  os_release: os.release(),
})

const registry = new WindowRegistry<BrowserWindow>()
// Renderers tell their runtimes whether anyone is looking; background work
// (terminal process scans) backs off while the app has no focus.
app.on('browser-window-focus', () => registry.broadcast(C.appAttention, [true]))
app.on('browser-window-blur', () => registry.broadcast(C.appAttention, [false]))

const analytics = createAnalytics({
  dir: userData,
  enabled: app.isPackaged,
  context,
  installIdPreexisted: () => device.installIdPreexisted(),
  post: (body) => new Promise((resolve) => {
    try {
      const request = net.request({ method: 'POST', url: ANALYTICS_ENDPOINT })
      request.setHeader('Content-Type', 'application/json')
      request.setHeader('User-Agent', `Cate/${app.getVersion()}`)
      request.on('response', (response) => {
        response.on('data', () => {})
        response.on('end', () => resolve(!!response.statusCode && response.statusCode >= 200 && response.statusCode < 300))
        response.on('error', () => resolve(false))
      })
      request.on('error', () => resolve(false))
      request.end(body)
    } catch {
      resolve(false)
    }
  }),
  promptFeedback: (prompt) => {
    // After the first paint, so the dialog does not compete with it.
    setTimeout(() => {
      const main = registry.activeMain()
      if (main) main.win.webContents.send(C.analyticsFeedbackPrompt, prompt)
    }, 2500)
  },
})

// `npm run dev:update:<level>`: launch as if just updated from one level below.
const simulate = process.env.CATE_SIMULATE_UPDATE
if (!app.isPackaged && (simulate === 'major' || simulate === 'minor' || simulate === 'patch')) {
  analytics.simulateUpdateFrom(app.getVersion(), simulate)
}

initSentry({ isPackaged: app.isPackaged, version: app.getVersion(), home: app.getPath('home'), context })
installPersistentSessionTracking()

process.on('uncaughtException', (error) => {
  log.error('uncaughtException: %O', error)
  captureException(error)
  void flushSentry().finally(() => process.exit(1))
})
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection: %O', reason)
  captureException(reason)
})

const rendererUrl = process.env.ELECTRON_RENDERER_URL
const paths = shellPaths(__dirname)
const guestPreload = path.join(__dirname, '../preload/shellGuest.js')
const codeCellPreload = path.join(__dirname, '../preload/shellCodeCell.js')

let started = false
const focusWindow = (win: BrowserWindow) => {
  if (win.isMinimized()) win.restore()
  win.focus()
  // Windows and Linux refuse focus() from the background; a brief always-on-top raises it.
  if (process.platform !== 'darwin') {
    const pinned = win.isAlwaysOnTop()
    win.setAlwaysOnTop(true)
    win.focus()
    if (!pinned) win.setAlwaysOnTop(false)
  }
}

let createMainWindow: () => BrowserWindow = () => { throw new Error('not ready') }
const openRequests = createOpenRequests({
  target: () => {
    const main = registry.activeMain()
    return main ? { contents: main.win.webContents, focus: () => focusWindow(main.win) } : undefined
  },
  createMainWindow: () => { createMainWindow() },
  started: () => started,
  channels: { path: C.openPath, url: C.openUrl },
  focusOnDeliver: !IS_E2E,
})
// Before ready: macOS sends these as early as the launch itself.
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  openRequests.openPath(filePath)
})
app.on('open-url', (event, url) => {
  event.preventDefault()
  openRequests.openUrl(url)
})

// This build's runtime installs in the background; a local dial waits for it
// (and retries the install after a failure).
let runtimeInstall: Promise<string> | null = null
const ensureRuntime = (): Promise<string> => {
  if (process.env.CATE_RUNTIME_BUNDLE) return Promise.resolve('')
  runtimeInstall ??= installBundledRuntime({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  }).catch((error) => {
    runtimeInstall = null
    log.error('runtime install failed: %O', error)
    throw new Error(`The Cate runtime could not be installed: ${(error as Error).message}`)
  })
  return runtimeInstall
}
void ensureRuntime().catch(() => {})

// "Open settings file" opens the device settings.json in the OS; it exists
// only once something was set, so give it one to open.
const settingsFile = path.join(userData, 'settings.json')
try { fs.writeFileSync(settingsFile, '{}\n', { flag: 'wx' }) } catch { /* exists */ }
const backgrounds = createCanvasBackgrounds(path.join(userData, CANVAS_BACKGROUNDS_DIR))
const partitions = createWebPartitions({
  session: (partition) => session.fromPartition(partition),
  upstream: () => settings().browserProxyUrl || undefined,
})

const quit = createQuitController({
  warnBeforeQuit: () => settings().warnBeforeQuit,
  blockers: () => appIpc?.blockers() ?? [],
  parentWindow: () => registry.focused()?.win ?? registry.activeMain()?.win,
  beforeExit: async () => {
    device.flushSync()
    await Promise.allSettled([flushPersistentSessions(), partitions.close(), flushSentry()])
  },
})
quit.install()
let appIpc: ReturnType<typeof registerAppIpc> | null = null

app.on('window-all-closed', () => app.quit())

app.whenReady().then(() => {
  log.info('Cate %s (electron %s, %s)', app.getVersion(), process.versions.electron, process.platform)
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({ applicationName: app.getName(), applicationVersion: app.getVersion(), version: app.getVersion(), copyright: `© ${new Date().getFullYear()} Cate` })
  }
  installAppCsp(rendererUrl)
  // This device's key exists from the first launch on (device-key.json, 0600).
  device.deviceKeys()

  const browser = createBrowserDesktop({
    codeCellPreload,
    downloadDir: () => app.getPath('downloads'),
    tempDir: () => path.join(app.getPath('temp'), 'cate-browser'),
    passkeys: process.platform === 'darwin',
  })
  const features = desktopClientFeatures(process.platform, { passkeysAvailable: browser.passkeysAvailable })

  app.on('login', (event, _contents, _details, authInfo, callback) => {
    if (!authInfo.isProxy) return
    const credentials = partitions.credentialsFor(authInfo.host, authInfo.port)
    if (!credentials) return
    event.preventDefault()
    callback(credentials.username, credentials.password)
  })
  installWebSecurity({
    guestPreload,
    rendererUrl,
    hardeningDisabled: featureFlags.disableWebviewHardening,
    guestKeys: () => menu.guestKeys(),
    isPreparedPartition: (partition) => partitions.isPrepared(partition),
  })

  const factory = createWindowFactory({
    registry,
    device,
    preload: paths.preload,
    rendererUrl,
    rendererFile: paths.rendererFile,
    icon: paths.icon,
    quitCommitted: () => quit.committed(),
    requestQuit: () => app.quit(),
    report: captureMessage,
  })
  createMainWindow = () => factory.createMainWindow()

  const updater = createAutoUpdater({
    updater: electronUpdater,
    app,
    state: createJsonStateFile({
      file: path.join(userData, PRIVATE_DEVICE_FILES.updateState),
      defaults: DEFAULT_UPDATE_RECORD,
      normalize: normalizeUpdateRecord,
    }),
    track: (name, props) => { void analytics.send(name, props) },
    broadcast: (status: UpdateStatus) => registry.broadcast(C.updateStatus, [status]),
    showMessageBox: (options) => dialog.showMessageBox(options),
    openExternal: (url) => { void shell.openExternal(url) },
    canSelfUpdate: () => canSelfUpdate(app),
    betaUpdatesEnabled: () => settings().betaUpdatesEnabled,
    devUpdate: process.env.CATE_DEV_UPDATE === '1',
  })

  const menu = createAppMenu({
    registry,
    newMainWindow: () => { revealWindow(factory.createMainWindow()) },
  })

  const pins = new KnownRuntimes(deviceStoreOf(device))
  const e2ePath = IS_E2E ? process.env.CATE_E2E_PATH_PREPEND : undefined
  const runtimeEnv = e2ePath ? { ...process.env, PATH: `${e2ePath}${path.delimiter}${process.env.PATH ?? ''}` } : process.env
  const host = createShellTransportHost({
    startLocal: async (root) => {
      let installDir = await ensureRuntime()
      // Another app's pruning may have removed it since (a checkout and the
      // packaged app on one machine): install again.
      if (installDir && !isRuntimeInstalled(installDir)) {
        runtimeInstall = null
        installDir = await ensureRuntime()
      }
      const bundle = process.env.CATE_RUNTIME_BUNDLE
      return startLocalRuntime({
        root,
        env: runtimeEnv,
        ...(bundle ? { launch: { node: process.env.CATE_RUNTIME_NODE || 'node', bundle } } : { installDir }),
      })
    },
    deviceKeys: () => device.deviceKeys(),
    deviceName: () => os.hostname().replace(/\.local$/, ''),
    pins,
  })

  registerDeviceIpc(device, registry)
  registerNatives({ registry, settingsFile, backgrounds, focusWindow })
  registerCapture(registry)
  registerTransportIpc({ host, partitions })
  registerSshIpc(createSshProvisioner({ build: RUNTIME_BUILD, version: RUNTIME_VERSION }))
  const perf = startPerfMonitor(featureFlags.perf())
  appIpc = registerAppIpc({
    registry,
    factory,
    menu,
    updater,
    analytics,
    openRequests,
    focusWindow,
    perf: () => perf.latest(),
    appInfo: () => ({
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      e2e: IS_E2E,
      features,
      device: { name: os.hostname().replace(/\.local$/, ''), keyFingerprint: device.deviceFingerprint() },
    }),
  })

  installThemeBootCache(device, nativeTheme)
  let previous = settings()
  backgrounds.prune(previous.canvasBackgroundImagePath)
  device.subscribe((name) => {
    if (name !== 'settings') return
    const next = settings()
    if (next.betaUpdatesEnabled !== previous.betaUpdatesEnabled) updater.setBetaUpdates(next.betaUpdatesEnabled)
    if (next.canvasBackgroundImagePath !== previous.canvasBackgroundImagePath) backgrounds.prune(next.canvasBackgroundImagePath)
    previous = next
  })

  app.on('activate', () => {
    if (registry.list().length === 0) factory.createMainWindow()
  })

  const main = factory.createMainWindow()
  let ready = false
  const onReady = () => {
    if (ready || main.isDestroyed()) return
    ready = true
    started = true
    openRequests.flush()
    updater.start()
    if (!IS_E2E) analytics.reportLaunch(app.getVersion())
    if (process.env.CATE_SMOKE_TEST === '1') {
      // The preload bridge and a round trip through main.
      void main.webContents.executeJavaScript(`(async () => {
        const desktop = window.cateDesktop
        if (typeof desktop !== 'object') return false
        const info = await desktop.app.info()
        await desktop.device.set('ui-state', { smoke: true })
        const state = await desktop.device.get('ui-state')
        return info.features.includes('webview') && info.device.keyFingerprint.length === 20 && state.smoke === true
      })()`, true).then((ok) => app.exit(ok ? 0 : 1), () => app.exit(1))
    }
  }
  main.once('ready-to-show', onReady)
  main.webContents.once('did-finish-load', onReady)
}).catch((error) => {
  log.error('startup failed: %O', error)
  captureException(error)
})
