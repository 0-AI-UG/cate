const { app, BrowserWindow, screen } = require('electron')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { shapeForBounds } = require('./region.cjs')

const execute = promisify(execFile)
const platform = process.platform
assert(['linux', 'win32'].includes(platform), 'Run on Windows or a private Linux X11 display')
if (platform === 'linux') {
  assert(process.env.CATE_FIXTURE_XVFB === '1' && process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
    'Run this Linux click fixture in a dedicated xvfb-run process')
  app.commandLine.appendSwitch('ozone-platform', 'x11')
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
}
assert(process.env.SHAPE_PROFILE, 'Use an empty SHAPE_PROFILE')
app.setPath('userData', process.env.SHAPE_PROFILE)
app.commandLine.appendSwitch('disable-gpu-compositing')

const page = color => 'data:text/html,' + encodeURIComponent(`<!doctype html>
  <style>html{background:${color};width:100%;height:100%}</style>
  <script>window.clicks=0;addEventListener('mousedown', event=>{
    if (event.isTrusted) window.clicks++;
  });</script>`)
const opaque = {x:75, y:90}
const hole = {x:185, y:90}
const readClicks = window => window.webContents.executeJavaScript('window.clicks')
const handle = window => {
  const bytes = window.getNativeWindowHandle()
  return bytes.length === 8 ? bytes.readBigUInt64LE().toString() : String(bytes.readUInt32LE())
}

async function raise(window) {
  if (platform === 'linux') {
    await execute('xdotool', ['windowraise', handle(window)], {timeout:3000})
  } else {
    window.moveTop()
  }
}

async function hitTargets(top, bottom, expected) {
  if (platform === 'win32') {
    const bounds = top.getContentBounds()
    const physical = point => screen.dipToScreenPoint({x: bounds.x + point.x, y: bounds.y + point.y})
    const a = physical(opaque)
    const b = physical(hole)
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
      join(__dirname, 'hit-window.ps1'), String(a.x), String(a.y), String(b.x), String(b.y)], {timeout:8000})
    const ids = JSON.parse(stdout)
    return {opaque: ids.opaque === handle(expected[0]), hole: ids.hole === handle(expected[1]), ids}
  }

  const bounds = top.getContentBounds()
  const click = point => execute('xdotool', ['mousemove', '--sync',
    String(bounds.x + point.x), String(bounds.y + point.y), 'click', '1'], {timeout:3000})
  const counts = () => Promise.all([readClicks(top), readClicks(bottom)])
  const before = await counts()
  await click(opaque)
  await delay(50)
  const middle = await counts()
  await raise(top)
  await click(hole)
  await delay(50)
  const after = await counts()
  const delivered = (previous, next, target) => next[0] === previous[0] + Number(target === top) &&
    next[1] === previous[1] + Number(target === bottom)
  return {
    opaque: delivered(before, middle, expected[0]),
    hole: delivered(middle, after, expected[1]),
    counts: {before, middle, after},
  }
}

async function run() {
  const bounds = {x: 30, y: 60, width: 260, height: 170}
  const options = {...bounds, show:false, frame:false, skipTaskbar:true, resizable:false,
    useContentSize:true, webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}}
  const bottom = new BrowserWindow(options)
  const top = new BrowserWindow(options)
  try {
    await Promise.all([bottom.loadURL(page('#371a42')), top.loadURL(page('#179846'))])
    const viewport = () => top.webContents.executeJavaScript('[innerWidth,innerHeight]')
    const original = await viewport()
    const outer = { left:0, top:0, right:bounds.width, bottom:bounds.height }
    const region = shapeForBounds(true, outer, [{left:150,top:40,right:225,bottom:120}])
    assert(region.visible)
    top.setShape(region.rectangles)
    bottom.showInactive()
    top.showInactive()
    await raise(top)
    await delay(150)
    assert.deepEqual(await viewport(), original, 'native shape changed the browser viewport')
    const hit = await hitTargets(top, bottom, [top, bottom])
    assert(hit.opaque && hit.hole, JSON.stringify(hit))
    const moved = shapeForBounds(true, outer, [{left:40,top:40,right:110,bottom:120}])
    assert(moved.visible)
    top.setShape(moved.rectangles)
    await raise(top)
    await delay(150)
    const movedHit = await hitTargets(top, bottom, [bottom, top])
    assert(movedHit.opaque && movedHit.hole, JSON.stringify(movedHit))
    assert.deepEqual(await viewport(), original)
    return {platform, electron:process.versions.electron, viewport:original,
      rectangles:region.rectangles, hit, movedRectangles:moved.rectangles, movedHit}
  } finally {
    top.destroy()
    bottom.destroy()
  }
}
app.whenReady().then(run).then(result => {
  console.log(JSON.stringify(result, null, 2))
  app.exit(0)
}, error => {
  console.error(error)
  app.exit(1)
})
