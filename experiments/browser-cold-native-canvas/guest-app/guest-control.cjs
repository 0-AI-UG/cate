const { createServer } = require('node:net')
const path = require('node:path')
const { scaleClip } = require('./scale-clip.cjs')

const wrapped = process.env.PROBE_WRAPPED_PANES === '1'

exports.serve = ({ BrowserWindow, session, screen, registry, stats }) => {
  const guests = new Map()
  const openings = new Map()
  let peer
  const send = (message) => { if (peer?.writable) peer.write(JSON.stringify(message) + '\n') }

  const load = (contents, url) => {
    if (new URL(url).origin !== process.env.PROBE_ORIGIN && url !== process.env.PROBE_REMOTE_TARGET) {
      throw new Error('Fixture navigation outside the allowed origins')
    }
    return contents.loadURL(url)
  }

  async function open(slot, {src, width, height, partition}) {
    if (!Number.isInteger(slot) || slot < 1 || slot > 127 || guests.has(slot)) throw new Error('Unknown or duplicate fixture slot')
    const window = new BrowserWindow({
      width, height, useContentSize: true, show: false, frame:false,
      ...(wrapped && { transparent: true, backgroundColor: '#00000000' }),
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
        ...(wrapped ? { webviewTag: true } : { session: session.fromPartition(partition) }),
      },
    })
    const embedder = window.webContents
    let contents = embedder
    if (wrapped) {
      try {
        await window.loadFile(path.join(__dirname, 'mask.html'))
        const attachment = new Promise(resolve => {
          embedder.once('did-attach-webview', (_, view) => resolve(view))
        })
        await embedder.executeJavaScript(`(() => {
          const view = document.createElement('webview')
          view.partition = ${JSON.stringify(partition)}
          view.src = 'about:blank'
          document.body.append(view)
        })()`)
        contents = await attachment
      } catch (error) {
        window.destroy()
        throw error
      }
    }
    const guest = { slot, window, contents, placements:0, zoom:1 }
    guests.set(slot, guest)
    stats.opened++
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const state = () => ({
      url: contents.getURL(), title: contents.getTitle(),
      back: contents.navigationHistory.canGoBack(), forward: contents.navigationHistory.canGoForward(),
      loading: contents.isLoading(),
    })
    const notice = (event, extra = {}) => send({ slot, event, state: state(), extra })
    for (const event of ['dom-ready', 'did-start-loading', 'did-stop-loading']) contents.on(event, () => notice(event))
    contents.on('did-navigate', (_event, url) => notice('did-navigate', { url }))
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => notice('did-navigate-in-page', { url, isMainFrame }))
    contents.on('page-title-updated', (_event, title) => notice('page-title-updated', { title }))
    contents.on('render-process-gone', (_event, details) => notice('render-process-gone', details))
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) =>
      notice('did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame }))
    window.once('closed', () => {
      guests.delete(slot)
      stats.closed++
    })
    return load(contents, src)
  }
  const pageOps = {
    load: (guest, url) => load(guest.contents, url),
    back: ({contents}) => contents.navigationHistory.goBack(),
    forward: ({contents}) => contents.navigationHistory.goForward(),
    reload: ({contents}) => contents.reload(),
    reloadIgnoringCache: ({contents}) => contents.reloadIgnoringCache(),
    css: ({contents}, css) => contents.insertCSS(css),
    zoom: (guest, zoom) => { guest.zoom = zoom; guest.contents.setZoomFactor(zoom * (guest.scale ?? 1)) },
    place: (guest, bounds) => {
      guest.placements++
      guest.requestedBounds = bounds
      const { x, y, width, height, logicalWidth, logicalHeight, clipPath, visible } = bounds
      if (![x,y,width,height,logicalWidth].every(Number.isFinite) || width <= 0 || height <= 0 || logicalWidth <= 0) return
      const next = { x:Math.round(x), y:Math.round(y), width:Math.round(width), height:Math.round(height) }
      const old = guest.window.getBounds()
      if (next.x !== old.x || next.y !== old.y || next.width !== old.width || next.height !== old.height) guest.window.setBounds(next)
      const scale = next.width / logicalWidth
      if (guest.scale !== scale) {
        guest.contents.setZoomFactor(guest.zoom * scale)
        guest.scale = scale
      }
      if (!wrapped || process.env.PROBE_CANVAS_CLIP !== '1' || !logicalHeight) return
      const current = {
        clip: scaleClip(clipPath, scale, next.height / logicalHeight),
        visibility: visible ? 'visible' : 'hidden',
      }
      if (guest.clipState?.clip === current.clip && guest.clipState?.visibility === current.visibility) return
      guest.clipState = current
      if (current.clip.startsWith('path(')) guest.clipPaths = (guest.clipPaths ?? 0) + 1
      async function flushClip() {
        if (guest.clipPending) return
        guest.clipPending = true
        let applied
        try {
          while (applied !== guest.clipState && !guest.window.isDestroyed()) {
            applied = guest.clipState
            await guest.window.webContents.executeJavaScript(`Object.assign(document.querySelector('webview').style, ${JSON.stringify({
              clipPath: applied.clip, visibility: applied.visibility,
            })}); void 0`)
            guest.appliedClip = applied
          }
        } catch (error) {
          if (!guest.window.isDestroyed()) stats.errors.push(String(error))
        } finally {
          guest.clipPending = false
        }
      }
      void flushClip()
    },
    attach: ({contents}, ref) => registry.attach(contents, { panelId: ref.panelId, tabId: ref.tabId }),
    execute: ({contents}, {ref, method, args}) => registry.execute(contents.id, ref, method, args),
    restart: ({contents}) => registry.restartIfHung(contents.id),
    close: ({window}) => window.destroy(),
  }

  globalThis.browserGuestStats = () => ({
    ...stats,
    activeGuests: [...guests.entries()].map(([slot, guest]) => ({
      slot, id:guest.contents.id, pid:guest.contents.getOSProcessId(), url:guest.contents.getURL(),
      visible:guest.window.isVisible(), window:guest.window.getBounds(), placements:guest.placements, requestedBounds:guest.requestedBounds,
      partition:guest.contents.session.getStoragePath(),
      appliedClip:guest.appliedClip, clipPaths:guest.clipPaths,
    })),
  })
  return new Promise((resolve, reject) => {
    globalThis.captureGuest = async slot => (await guests.get(slot).window.webContents.capturePage()).toPNG().toString('base64')
    globalThis.clickGuest = async (slot, x, y) => {
      const cdp = guests.get(slot).window.webContents.debugger
      cdp.attach('1.3')
      try {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await cdp.sendCommand('Input.dispatchMouseEvent', { type, x, y, button:'left', clickCount:1 })
        }
      } finally {
        cdp.detach()
      }
    }
    globalThis.animateClips = duration => Promise.all([...guests.values()].map(({window}) =>
      window.webContents.executeJavaScript(`new Promise(resolve => {
        const view = document.querySelector('webview')
        let start, previous, max = 0, frames = 0
        function apply(now) {
          start ??= now
          if (previous !== undefined) max = Math.max(max, now - previous)
          previous = now
          frames++
          const top = 25 + 12 * Math.sin((now - start) / 360)
          const bottom = top + 23
          view.style.clipPath = 'polygon(0 0, 100% 0, 100% '+top+'%, 64% '+top+'%, 64% '+bottom+'%, 100% '+bottom+'%, 100% 100%, 0 100%)'
          if (now - start < ${duration}) requestAnimationFrame(apply)
          else resolve({frames,max,startedAt: performance.timeOrigin + start,endedAt: performance.timeOrigin + now})
        }
        requestAnimationFrame(apply)
      })`)))
    globalThis.settleClips = () => Promise.all([...guests.values()].map(({window}) =>
      window.webContents.executeJavaScript(`(() => {
        document.querySelector('webview').style.clipPath = 'polygon(0 0, 100% 0, 100% 25%, 64% 25%, 64% 60%, 100% 60%, 100% 100%, 0 100%)'
      })()`)))
    globalThis.evaluateGuest = (slot, script) => guests.get(slot).contents.executeJavaScript(script)
    globalThis.runNativeFixtureWheels = async ({slot,hostOrigin,durationMs}) => {
      if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Only inject native input on the hosted desktop')
      const {setTimeout: wait} = require('node:timers/promises')
      const guest = guests.get(slot)
      if (!guest?.requestedBounds.inert) throw new Error('Expected an unfocused browser pane')
      const native = require('./native.node')
      let sent = 0, posted = 0, lostInert = 0, wrongTarget = 0, outsideDisplay = 0
      native.beginWheelRoute(guest.window.getNativeWindowHandle(), wheel => {
        const bounds = guest.window.getContentBounds()
        if (!guest.requestedBounds.inert) { lostInert++; return }
        send({wheel:{id:sent++, x:bounds.x+wheel.x-hostOrigin.x, y:bounds.y+wheel.y-hostOrigin.y,
          deltaX:wheel.deltaX,deltaY:wheel.deltaY,control:wheel.control,time:performance.timeOrigin+performance.now()}})
      }, true)
      const timer = setInterval(() => {
        const bounds = guest.window.getContentBounds()
        const display = screen.getDisplayMatching(bounds).bounds
        const left = Math.max(bounds.x, display.x, hostOrigin.x)
        const top = Math.max(bounds.y, display.y, hostOrigin.y+100)
        const right = Math.min(bounds.x+bounds.width,display.x+display.width,hostOrigin.x+hostOrigin.width)
        const bottom = Math.min(bounds.y+bounds.height,display.y+display.height,hostOrigin.y+hostOrigin.height)
        if (right-left < 12 || bottom-top < 12) { outsideDisplay++; return }
        const x = Math.round(left+(right-left)*.75-bounds.x)
        const y = Math.round(top+(bottom-top)*.65-bounds.y)
        const hit = native.getHit(guest.window.getNativeWindowHandle(),x,y,0)
        if (hit.hit !== hit.self) {wrongTarget++; return}
        const delta = posted++ % 120 < 60 ? -1 : 1
        if (!native.queueWheel(guest.window.getNativeWindowHandle(),x,y,0,delta,true)) {
          clearInterval(timer)
        }
      }, 22)
      try {
        await wait(durationMs)
        return {sent,posted,lostInert,wrongTarget,outsideDisplay}
      } finally {
        clearInterval(timer)
        native.endWheelRoute()
      }
    }
    globalThis.showNativeGuestWindows = hostWindowId => {
      if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Only show the hosted fixture')
      for (const {window} of guests.values()) {
        window.showInactive()
        window.moveAbove('window:'+hostWindowId+':0')
      }
    }
    globalThis.runFixtureWheels = async ({action, x, y, durationMs}) => {
      const {setTimeout: wait} = require('node:timers/promises')
      let sent = 0
      const control = action === 'zoom'
      const timer = setInterval(() => {
        const phase = sent * .023
        const deltaX = control ? 0 : -3.1 * Math.cos(phase)
        const deltaY = control ? -.3 * Math.cos(phase) : -2.1 * Math.sin(phase)
        send({wheel:{id:sent++, x,y,deltaX,deltaY,control,time:performance.timeOrigin + performance.now()}})
      }, 16)
      try {
        await wait(durationMs)
        return sent
      } finally {
        clearInterval(timer)
      }
    }
    const server = createServer(connection => {
      if (peer?.writable) return connection.destroy()
      peer = connection
      connection.setEncoding('utf8')
      let buffer = ''
      connection.on('data', fragment => {
        buffer += fragment
        let end
        while ((end = buffer.indexOf('\n')) >= 0) {
          const { id, method, args: request } = JSON.parse(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          void Promise.resolve().then(async () => {
            const { slot, args } = request
            if (method === 'open') {
              if (openings.has(slot)) throw new Error('Duplicate opening slot')
              const opening = open(slot, args)
              openings.set(slot, opening)
              try {
                return await opening
              } finally {
                openings.delete(slot)
              }
            }
            await openings.get(slot)
            const guest = guests.get(slot)
            if (!guest || !Object.hasOwn(pageOps, method)) throw new Error('Unknown fixture guest or operation')
            return pageOps[method](guest, args)
          }).then(result => { if (id) send({ id, result }) }, error => {
            const message = String(error.message ?? error)
            if (id) send({ id, error:message })
            else stats.errors.push(message)
          })
        }
      })
    })
    server.once('error', reject)
    server.listen(process.env.PROBE_CONTROL, resolve)
  })
}
