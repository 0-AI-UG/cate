// Test doubles for the desktop renderer: a fake `window.cateDesktop` whose
// local dials reach a server the test provides (an in-process RpcServer), so
// boot and render tests run the real client stack in jsdom.

import { vi } from 'vitest'
import { framePortOver, type ByteDuplex, type ClientFeature, type FramePort } from '@kernel/rpc/contract'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import type { DesktopApi, DesktopAppInfo, PipeMessage } from '@shells/desktop/contract'

/** Two ends of an in-memory byte pipe; delivery is asynchronous. */
export function bytePipe(): [ByteDuplex, ByteDuplex] {
  const data: ((b: Uint8Array) => void)[] = [() => {}, () => {}]
  const close: ((r?: string) => void)[][] = [[], []]
  let closed = false
  const end = (self: 0 | 1): ByteDuplex => ({
    write(bytes) {
      if (closed) return
      const copy = bytes.slice()
      queueMicrotask(() => data[1 - self](copy))
    },
    onData(listener) { data[self] = listener },
    onClose(listener) { close[self].push(listener) },
    close(reason) {
      if (closed) return
      closed = true
      queueMicrotask(() => { for (const l of [...close[0], ...close[1]]) l(reason) })
    },
  })
  return [end(0), end(1)]
}

/** What a fake local dial reaches: an RpcServer in the test. */
export interface FakeRuntimeServer {
  serve(port: FramePort): unknown
}

export interface FakeDesktop {
  api: DesktopApi
  info: DesktopAppInfo
  device: ReturnType<typeof createMemoryDeviceStore>
}

/** A `DesktopApi` for jsdom: dialogs answer "cancel", OS actions do nothing,
 *  and `dialLocal` reaches `runtime` when one is given. */
export function createFakeDesktop(options: { features?: ClientFeature[]; runtime?: FakeRuntimeServer; device?: Record<string, unknown> } = {}): FakeDesktop {
  const device = createMemoryDeviceStore(options.device)
  const info: DesktopAppInfo = {
    version: '9.0.0',
    platform: 'linux',
    arch: 'x64',
    isPackaged: false,
    e2e: false,
    features: options.features ?? [],
    device: { name: 'test', publicKey: 'FP' },
    window: { kind: 'main' },
  }
  const pipes = new Map<string, ByteDuplex>()
  let nextPipe = 0
  const off = () => () => {}
  const api: DesktopApi = {
    app: {
      info: async () => info,
      setQuitBlockers: vi.fn(),
      onOpenPath: off,
      onOpenUrl: off,
      onAttention: off,
      openRequestsReady: vi.fn(),
      perf: async () => null,
    },
    device,
    windows: { open: vi.fn(async () => {}), close: vi.fn(async () => {}), focus: vi.fn(async () => {}), list: async () => [] },
    window: {
      newMainWindow: async () => {},
      minimize: async () => {},
      toggleMaximize: async () => {},
      close: async () => {},
      setTitle: vi.fn(async () => {}),
      state: async () => ({ fullscreen: false, maximized: false, focused: true }),
      onState: off,
      onCloseRequested: off,
      anyFullscreen: () => false,
      setZoomFactor: vi.fn(),
    },
    menu: {
      showContextMenu: async () => null,
      barItems: async () => [],
      popupBarItem: async () => {},
      runNativeAction: async () => {},
      setModel: async () => {},
      onAction: off,
    },
    dialogs: {
      messageBox: async (request) => request.cancelId ?? 0,
      open: async () => null,
      pickCanvasBackground: async () => null,
      readCanvasBackground: async () => null,
      pruneCanvasBackgrounds: async () => {},
    },
    os: {
      openExternal: vi.fn(async () => {}),
      openSettingsFile: vi.fn(async () => {}),
      writeClipboard: async () => {},
      readClipboard: async () => '',
      notify: vi.fn(async () => {}),
      onNotificationAction: off,
    },
    updates: { status: async () => ({ state: 'idle', version: null }), check: async () => {}, install: async () => false, onStatus: off },
    analytics: {
      track: () => {},
      feedbackPending: async () => null,
      submitFeedback: async () => ({ ok: true }),
      dismissFeedback: () => {},
      onFeedbackPrompt: off,
    },
    capture: {
      window: async () => null,
      recentScreenshots: async () => [],
      onRecentScreenshots: off,
      readRecentScreenshot: async () => new Uint8Array(),
      dragRecentScreenshot: async () => {},
      addAnnotatedScreenshot: async (ref) => ({ id: `annotated:${ref.path}`, thumbnail: 'data:image/png;base64,', ref }),
    },
    drag: {
      start: async () => null,
      claim: async () => null,
      end: async () => ({ claimed: false }),
      cancel: async () => {},
      onPointer: off,
      onEnded: off,
    },
    machines: {
      ensureRuntime: async () => { throw new Error('no machines') },
      listDir: async () => { throw new Error('no machines') },
      mkdir: async () => { throw new Error('no machines') },
      wslDistros: async () => [],
      cancel: async () => {},
    },
    transports: {
      async dialLocal() {
        if (!options.runtime) throw new Error('no runtime')
        const [client, server] = bytePipe()
        options.runtime.serve(framePortOver(server, 'stream'))
        const id = `pipe-${nextPipe++}`
        pipes.set(id, client)
        return id
      },
      dialMachine: async () => { throw new Error('no machines') },
      dialNetwork: async () => { throw new Error('no network') },
      dialLoopbackTcp: async () => { throw new Error('no loopback') },
      pair: async () => { throw new Error('no pairing') },
      onLoopbackRequest: off,
    },
    pipes: {
      onMessage(pipe, listener: (message: PipeMessage) => void) {
        const duplex = pipes.get(pipe)
        if (!duplex) return () => {}
        duplex.onData((bytes) => listener(bytes))
        duplex.onClose((reason) => listener({ t: 'close', reason }))
        return () => {}
      },
      write: (pipe, bytes) => pipes.get(pipe)?.write(bytes),
      open: () => {},
      close: (pipe, reason) => pipes.get(pipe)?.close(reason),
    },
    web: {
      partitionFor: async ({ runtimeId }) => `persist:ws-${runtimeId}`,
      release: async () => {},
      setCookie: async () => {},
    },
    webgl: { request: async () => false, release: () => {} },
  }
  return { api, info, device }
}
