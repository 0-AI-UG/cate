import { browserKeyEvent, type BrowserEngineBridge, type BrowserSurfaceConnection, type BrowserSurfaceOptions } from '../../contract/engine'

declare global { interface Window { cateBrowserEngine?: BrowserEngineBridge } }

// The view owns the DOM input target. The page lives only in the engine.
// All synchronous reads below use received state, never a main-process call.
export function createEngineSurface(element: HTMLCanvasElement, normalInput: HTMLTextAreaElement, secureInput: HTMLInputElement, initial: BrowserSurfaceConnection, options: BrowserSurfaceOptions, bridge: BrowserEngineBridge) {
  let input: HTMLInputElement | HTMLTextAreaElement = normalInput
  let connection = initial
  let socket: WebSocket
  let reconnecting: Promise<void> | undefined
  let state = { ready: false, url: '', title: '', loading: true, canGoBack: false, canGoForward: false }
  let zoom = 1
  let visible = true
  let disposed = false
  let frames = 0
  const isMac = navigator.platform.includes('Mac')
  // Reuse CPU-backed pixels on macOS. Transferring a new bitmap to the
  // canvas for every frame leaves substantially more graphics memory in use.
  const cpuContext = isMac ? element.getContext('2d', { alpha: false, willReadFrequently: true }) : null
  const bitmapContext = cpuContext ? null : element.getContext('bitmaprenderer', { alpha: false })
  const crash = () => { if (!disposed) element.dispatchEvent(Object.assign(new Event('render-process-gone'), { reason: 'crashed' })) }
  const reconnect = (url = state.url || options.url) => reconnecting ??= bridge.create({ ...options, url, width: element.clientWidth || options.width, height: element.clientHeight || options.height }).then(next => {
    if (disposed) { void bridge.close(next.id).catch(() => {}); return }
    socket.close(); void bridge.close(connection.id).catch(() => {}); connection = next; connect()
  }).catch(crash).finally(() => { reconnecting = undefined })
  const send = (message: object) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)) }
  const focus = (value: boolean) => { bridge.focus(connection.id, value); send({ type: value ? 'focus' : 'blur' }) }
  const originalFocus = () => input.focus({ preventScroll: true })
  const surface = Object.assign(element, {
    getWebContentsId: () => connection.id,
    getURL: () => state.url,
    getTitle: () => state.title,
    isLoading: () => state.loading,
    canGoBack: () => state.canGoBack,
    canGoForward: () => state.canGoForward,
    getZoomFactor: () => zoom,
    setZoomFactor: (factor: number) => { zoom = factor; send({ type: 'zoom', factor }) },
    loadURL: async (url: string) => { if (socket.readyState >= WebSocket.CLOSING) await reconnect(url); else send({ type: 'navigate', url }) },
    goBack: () => send({ type: 'back' }),
    goForward: () => send({ type: 'forward' }),
    reload: () => { if (socket.readyState >= WebSocket.CLOSING) void reconnect(); else send({ type: 'reload' }) },
    reloadIgnoringCache: () => { if (socket.readyState >= WebSocket.CLOSING) void reconnect(); else send({ type: 'reload', hard: true }) },
    insertCSS: async (css: string) => { send({ type: 'css', css }); return '' },
    setVisible: (value: boolean) => { visible = value; send({ type: 'visible', value }); if (!value && document.activeElement === input) input.blur() },
    focus: () => { originalFocus(); focus(true) },
  })
  element.tabIndex = 0
  element.dataset.scrollSurface = ''
  element.dataset.browserEngine = String(connection.id)
  const connect = () => {
    delete element.dataset.browserEngineError
    const active = socket = new WebSocket(connection.url, connection.token)
    active.binaryType = 'blob'
    element.dataset.browserEngine = String(connection.id)
    active.onclose = () => { if (socket === active) crash() }
    active.onmessage = async event => {
      if (disposed || socket !== active) return
      try {
        if (event.data instanceof Blob) {
          try {
            const bitmap = await createImageBitmap(event.data)
            try {
              if (disposed || socket !== active) return
              const { width, height } = bitmap
              if (!width || !height || width > 16384 || height > 16384) throw new Error('invalid-browser-frame')
              if (element.width !== width) element.width = width
              if (element.height !== height) element.height = height
              if (cpuContext) cpuContext.drawImage(bitmap, 0, 0)
              else bitmapContext!.transferFromImageBitmap(bitmap)
              element.dataset.browserFrames = String(++frames)
            } finally {
              bitmap.close()
            }
          } finally {
            if (active.readyState === WebSocket.OPEN) active.send(JSON.stringify({ type: 'ack' }))
          }
          return
        }
        const message = JSON.parse(event.data)
        state = message.state
        const { type, state: _state, ...detail } = message
        if (type === 'cursor') { element.style.cursor = ({ pointer: 'pointer', hand: 'pointer', arrow: 'default', ibeam: 'text', cross: 'crosshair', handGrab: 'grab', handGrabbing: 'grabbing' } as Record<string, string>)[detail.cursor] ?? detail.cursor; return }
        if (type === 'input-context') {
          const context = detail.context
          const next = context?.secure ? secureInput : normalInput
          if (next !== input) { const focused = document.activeElement === input; input = next; if (focused) surface.focus() }
          input.setAttribute('aria-label', context?.label || 'Web page input')
          if (context?.caret) { input.style.left = `${Math.max(0, Math.min(element.clientWidth, context.caret.x))}px`; input.style.top = `${Math.max(0, Math.min(element.clientHeight, context.caret.y))}px`; input.style.height = `${context.caret.height}px` }
          input.inputMode = context?.mode || 'text'
          return
        }
        if (type === 'connected') {
          element.dispatchEvent(new Event('did-start-loading'))
          if (state.ready) element.dispatchEvent(new Event('dom-ready'))
          send({ type: 'visible', value: visible })
          send({ type: 'resize', width: element.clientWidth, height: element.clientHeight })
          if (!state.loading) element.dispatchEvent(new Event('did-stop-loading'))
        } else element.dispatchEvent(Object.assign(new Event(type), detail))
      } catch (error) { element.dataset.browserEngineError = String(error); crash(); active.close() }
    }
  }
  connect()
  const point = (event: MouseEvent) => {
    const rect = element.getBoundingClientRect()
    return { x: Math.round((event.clientX - rect.left) * element.clientWidth / rect.width), y: Math.round((event.clientY - rect.top) * element.clientHeight / rect.height) }
  }
  const listeners: Array<() => void> = []
  const listen = <K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void, target: HTMLElement = element) => {
    target.addEventListener(type, handler)
    listeners.push(() => target.removeEventListener(type, handler))
  }
  const modifiers = (event: MouseEvent) => Number(event.altKey) | Number(event.ctrlKey) << 1 | Number(event.metaKey) << 2 | Number(event.shiftKey) << 3
  for (const [dom, type] of [['mousedown', 'mousePressed'], ['mouseup', 'mouseReleased'], ['mousemove', 'mouseMoved']] as const) listen(dom, event => {
    if (dom === 'mousedown') { event.preventDefault(); surface.focus() }
    send({ type: 'input', event: { type, ...point(event), button: event.buttons || dom !== 'mousemove' ? ['left', 'middle', 'right'][event.button] : 'none', buttons: event.buttons, clickCount: event.detail || 1, modifiers: modifiers(event) } })
    event.stopPropagation()
  })
  listen('pointerdown', event => { element.setPointerCapture(event.pointerId); event.stopPropagation() })
  listen('pointerup', event => event.stopPropagation())
  listen('focus', () => surface.focus())
  for (const target of [normalInput, secureInput]) {
    listen('focus', () => { input = target; focus(true) }, target)
    listen('blur', () => focus(false), target)
  }
  listen('wheel', event => { if (event.defaultPrevented) return; event.preventDefault(); event.stopPropagation(); send({ type: 'input', event: { type: 'mouseWheel', ...point(event), deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiers(event) } }) })
  let composing = false
  let committed = false
  for (const target of [normalInput, secureInput]) {
  for (const [dom, type] of [['keydown', 'keyDown'], ['keyup', 'keyUp']] as const) listen(dom, event => {
    if (event.defaultPrevented || event.isComposing || composing || event.key === 'Dead' || event.key === 'Process') return
    event.preventDefault()
    send({ type: 'key', event: browserKeyEvent({ type, key: event.key, code: event.code, keyCode: event.keyCode, alt: event.altKey, control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, altGraph: event.getModifierState('AltGraph'), repeat: event.repeat }, isMac ? 'darwin' : 'other') })
  }, target)
  listen('compositionstart', () => { composing = true; committed = false; input.value = '' }, target)
  listen('compositionupdate', event => send({ type: 'composition', text: event.data, start: event.data.length, end: event.data.length }), target)
  listen('compositionend', event => { composing = false; committed = true; send({ type: 'text', text: event.data }); input.value = '' }, target)
  listen('input', raw => {
    const event = raw as InputEvent
    if (composing || event.isComposing) return
    if (committed && (event.inputType === 'insertCompositionText' || event.inputType === 'insertFromComposition')) { committed = false; input.value = ''; return }
    committed = false
    if (input.value) send({ type: 'text', text: input.value })
    input.value = ''
  }, target)
  for (const action of ['copy', 'cut', 'paste'] as const) listen(action, event => { event.preventDefault(); send({ type: 'edit', action }) }, target)
  }
  const resize = new ResizeObserver(() => send({ type: 'resize', width: element.clientWidth, height: element.clientHeight }))
  resize.observe(element)
  return { surface, dispose() { disposed = true; resize.disconnect(); for (const stop of listeners) stop(); socket.close(); void bridge.close(connection.id).catch(() => {}) } }
}

export async function openEngineSurface(element: HTMLCanvasElement, input: HTMLTextAreaElement, secureInput: HTMLInputElement, options: BrowserSurfaceOptions) {
  const bridge = window.cateBrowserEngine!
  const connection = await bridge.create(options)
  return createEngineSurface(element, input, secureInput, connection, options, bridge)
}
