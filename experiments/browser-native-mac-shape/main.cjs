const { app, BrowserWindow, screen, webContents } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

app.setPath('userData', process.env.MASK_PROFILE)
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const root = process.env.MASK_PROFILE
assert(process.env.GITHUB_ACTIONS === 'true', 'This probe orders windows only on the hosted desktop')
const pagePath = path.join(root, 'page.html')
const shellPath = path.join(root, 'shell.html')
fs.writeFileSync(pagePath, `<!doctype html><style>
body { margin: 0; background: rgb(20, 180, 90); min-height: 900px }
input { position: absolute; top: 35px; left: 35px; width: 90px }
</style><input aria-label="input"><script>
window.trusted = 0
window.trustedClicks = 0
window.resizeCount = 0
addEventListener('resize', () => window.resizeCount++)
addEventListener('keydown', event => { if (event.isTrusted) window.trusted++ })
addEventListener('mousedown', event => { if (event.isTrusted) window.trustedClicks++ })
</script>`)
fs.writeFileSync(shellPath, `<!doctype html><style>
html, body { background: transparent; margin: 0 }
webview { position: absolute; left: 0; top: 0; width: 320px; height: 200px }
</style><webview partition="persist:browser" src="./page.html"></webview>`)

async function waitFor(read, matches, description, limit = 40, intervalMs = 50) {
  let value
  for (let attempt = 0; attempt < limit; attempt++) {
    value = await read()
    if (matches(value)) return value
    await delay(intervalMs)
  }
  assert.fail(`${description}: ${JSON.stringify(value)}`)
}

async function sample(window) {
  const image = await window.webContents.capturePage()
  const scale = image.getSize().width / 320
  return [[20, 20], [190, 100], [245, 100], [190, 175]].map(([x, y]) => {
    const b = image.crop({ x: Math.floor(x * scale), y: Math.floor(y * scale), width: 1, height: 1 }).toBitmap()
    assert.equal(b.length, 4)
    return Array.from(b)
  })
}

async function measureCursorGate(window, hitAt, ids, moveCursor) {
  const touched = [[20,20], [190,175]]
  const bounds = window.getContentBounds()
  const originalCursor = screen.getCursorScreenPoint()
  const cursor = ([x, y]) => ({ x:bounds.x + x, y:bounds.y + y })
  const move = ({x, y}) => assert.equal(moveCursor(x, y), 0, 'hosted cursor move rejected')
  const gateSamples = []
  try {
    for (const intervalMs of [4, 8]) {
      let ticks = 0, flips = 0, ignoring
      const poll = () => {
        ticks++
        const at = screen.getCursorScreenPoint()
        const x = at.x - bounds.x
        const y = at.y - bounds.y
        const accepts = x >= 0 && y >= 0 && x < bounds.width && y < bounds.height &&
          !(x >= 160 && y >= 146)
        if (ignoring !== !accepts) {
          ignoring = !accepts
          flips++
          window.setIgnoreMouseEvents(ignoring)
        }
      }
      move(cursor(touched[0]))
      await delay(35)
      poll()
      const timer = setInterval(poll, intervalMs)
      const delays = []
      let incorrectAtMove = 0
      try {
        for (let sample = 0; sample < 24; sample++) {
          const target = (sample + 1) % 2
          const point = touched[target]
          move(cursor(point))
          const start = performance.now()
          if (hitAt(point).hit !== ids[target]) incorrectAtMove++
          await waitFor(() => hitAt(point), state => state.hit === ids[target], 'cursor gate did not select the expected window', 45, 1)
          delays.push(performance.now() - start)
          // Avoid biasing every crossing to immediately follow a timer wakeup.
          await delay(13 + sample % 7)
        }
      } finally {
        clearInterval(timer)
      }
      delays.sort((a, b) => a - b)
      gateSamples.push({ intervalMs, ticks, flips, timesMs:delays, incorrectAtMove,
        p95Ms:delays[Math.ceil(delays.length * .95) - 1], maxMs:delays.at(-1) })
    }
  } finally {
    window.setIgnoreMouseEvents(false)
    move(originalCursor)
  }
  return gateSamples
}

async function checkNativeHit(window) {
  const addon = require('./hit-query.node')
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea
  const bounds = { x:x+Math.floor((width-320)/2), y:y+Math.floor((height-200)/2), width:320, height:200 }
  window.setBounds(bounds)
  const background = new BrowserWindow({ ...bounds, frame:false, show:false, backgroundColor:'#371a42' })
  await background.loadURL('about:blank')
  const front = window.getNativeWindowHandle()
  const back = background.getNativeWindowHandle()
  const solidPoint = [20,20]
  const holePoint = [190,175]
  const read = (handle, point, below = 0) => addon.getHit(handle, ...point, below)
  const readTarget = (point) => read(front, point)
  const setClip = clip => window.webContents.executeJavaScript(
    `document.querySelector('webview').style.clipPath = ${JSON.stringify(clip)}`)
  const clip = await window.webContents.executeJavaScript("document.querySelector('webview').style.clipPath")
  try {
    app.focus({steal:true})
    background.show()
    await waitFor(() => read(back, holePoint), state => state.hit === state.self,
      'background control did not become the native hit target')
    await setClip('none')
    window.show()
    window.moveTop()
    await waitFor(() => sample(window), pixels => pixels.every(pixel => pixel[3] === 255), 'front control did not paint')
    const solid = await waitFor(() => readTarget(solidPoint), state => state.hit === state.self,
      'opaque front control did not become the native hit target')
    const full = readTarget(holePoint)
    assert.equal(full.hit, solid.self)
    const bottom = read(back, holePoint, solid.self)
    assert.equal(bottom.hit, bottom.self)
    await setClip(clip)
    const presented = await waitFor(() => sample(window), pixels => pixels[0][3] === 255 && pixels[3][3] === 0,
      'on-screen browser did not apply actual transparent pixels')
    await delay(200)
    const visible = readTarget(solidPoint)
    const transparent = readTarget(holePoint)
    assert.equal(visible.hit, solid.self)
    assert([solid.self, bottom.self].includes(transparent.hit))
    window.setIgnoreMouseEvents(true)
    await waitFor(() => readTarget(solidPoint), state => state.hit === bottom.self,
      'ignoring front window did not expose opaque pixel')
    const cursorGate = await measureCursorGate(window, readTarget, [solid.self, bottom.self], addon.moveFixtureCursor)
    return { frontWindow:solid.self, backWindow:bottom.self, opaquePixelHit:visible.hit,
      transparentPixelHit:transparent.hit, perPixelClickThrough:transparent.hit === bottom.self,
      opaqueColor:presented[0], transparentColor:presented[3], cursorGate }
  } finally {
    window.hide()
    background.destroy()
  }
}

async function run() {
  const window = new BrowserWindow({ width: 320, height: 200, useContentSize: true,
    transparent: true, frame: false, show: false, resizable:false, backgroundColor: '#00000000',
    webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  })
  await window.loadFile(shellPath)
  const guest = await waitFor(() => webContents.getAllWebContents().find(wc => wc.getType() === 'webview' && wc.getURL().endsWith('/page.html')), Boolean, 'browser guest unavailable')
  const inspect = () => guest.executeJavaScript('({size:[innerWidth, innerHeight], scale:devicePixelRatio, value:document.querySelector("input").value, trusted, trustedClicks, resizeCount})')
  const green = pixel => pixel[3] === 255 && pixel[1] > 150 && pixel[2] < 35
  const baseline = await waitFor(() => sample(window), pixels => pixels.every(green), 'browser rectangle missing')
  const before = await inspect()
  // A rectangle with a notch entering from the right, as when another pane overlaps.
  await window.webContents.executeJavaScript(`document.querySelector('webview').style.clipPath =
    'polygon(0 0, 100% 0, 100% 30%, 50% 30%, 50% 70%, 100% 70%, 100% 100%, 0 100%)'`)
  const clipped = await waitFor(() => sample(window), pixels => green(pixels[0]) && pixels[1][3] === 0 && pixels[2][3] === 0 && green(pixels[3]), 'notch did not expose transparent pixels')
  const hit = () => window.webContents.executeJavaScript(`[[20,20],[190,100],[190,175]].map(([x,y])=>document.elementFromPoint(x,y)?.tagName)`)
  const initialHitTests = await hit()
  assert.deepEqual(initialHitTests, ['WEBVIEW', 'HTML', 'WEBVIEW'])
  const frames = await window.webContents.executeJavaScript(`new Promise(resolve => {
    const view = document.querySelector('webview')
    let started, frames = 0
    function move(now) {
      started ??= now
      const fraction = Math.min((now - started) / 200, 1)
      const top = 30 + 43 * fraction
      const bottom = 70 + 30 * fraction
      view.style.clipPath = 'polygon(0 0, 100% 0, 100% '+top+'%, 50% '+top+'%, 50% '+bottom+'%, 100% '+bottom+'%, 100% 100%, 0 100%)'
      frames++
      if (fraction < 1) requestAnimationFrame(move)
      else resolve(frames)
    }
    requestAnimationFrame(move)
  })`)
  assert(frames > 2)
  const moved = await waitFor(() => sample(window), pixels => green(pixels[0]) && green(pixels[1]) && green(pixels[2]) && pixels[3][3] === 0,
    'moving the notch did not update composited pixels')
  const movedHitTests = await hit()
  assert.deepEqual(movedHitTests, ['WEBVIEW', 'WEBVIEW', 'HTML'])
  const cdp = window.webContents.debugger
  cdp.attach('1.3')
  const click = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.sendCommand('Input.dispatchMouseEvent', { type, x, y, button:'left', clickCount:1 })
    }
  }
  await click(190, 175)
  assert.equal((await inspect()).trustedClicks, 0)
  await click(50, 45)
  await waitFor(() => guest.executeJavaScript('document.activeElement.tagName'), value => value === 'INPUT', 'browser input did not focus')
  await cdp.sendCommand('Input.dispatchKeyEvent', { type:'keyDown', key:'a', code:'KeyA', text:'a' })
  await cdp.sendCommand('Input.dispatchKeyEvent', { type:'keyUp', key:'a', code:'KeyA' })
  const after = await waitFor(inspect, state => state.value === 'a' && state.trusted === 1 && state.trustedClicks === 1, 'trusted browser input lost')
  cdp.detach()
  assert.deepEqual(before.size, [320, 200])
  assert.deepEqual(after.size, before.size)
  assert.equal(after.scale, before.scale)
  assert.equal(window.isVisible(), false)
  const features = app.getGPUFeatureStatus()
  assert.equal(features.gpu_compositing, 'disabled_software')
  const native = await checkNativeHit(window)
  return { native, baseline, clipped, moved, initialHitTests, movedHitTests, frames, before, after, features, versions: process.versions }
}
app.whenReady().then(run).then(result => {
  console.log(JSON.stringify(result, null, 2))
  app.exit(0)
}, error => {
  console.error(error)
  app.exit(1)
})
