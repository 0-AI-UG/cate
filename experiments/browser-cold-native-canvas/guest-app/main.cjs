const { app, BrowserWindow, session } = require('electron')
const { PageDriverRegistry } = require('./driver.cjs')

app.setPath('userData', process.env.PROBE_PROFILE)
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.on('window-all-closed', () => {})
if (process.env.PROBE_HELPER_SOFTWARE_COMPOSITOR === '1') app.commandLine.appendSwitch('disable-gpu-compositing')
if (process.env.PROBE_HELPER_CPU_RASTER === '1') app.commandLine.appendSwitch('disable-gpu-rasterization')
if (process.env.PROBE_HELPER_PRECOMPILE === '1') app.commandLine.appendSwitch('enable-skia-graphite-precompilation')
if (process.env.PROBE_HELPER_FEATURES) app.commandLine.appendSwitch('enable-features', process.env.PROBE_HELPER_FEATURES)
const stats = { opened:0, closed:0, errors:[] }
app.whenReady().then(async () => {
  app.dock?.hide()
  const registry = new PageDriverRegistry()
  await require('./guest-control.cjs').serve({ BrowserWindow, session, registry, stats })
  globalThis.controlReady = true
}).catch(error => { console.error(error); app.exit(1) })
