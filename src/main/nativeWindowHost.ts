import { spawn } from 'child_process'
import fs from 'fs'
import type {
  NativeAppBindRequest,
  NativeAppBindingStatus,
  NativeAppBounds,
  NativeAppConfig,
  NativeAppWindowInfo,
} from '../shared/types'
import { getNativeAppPreset } from '../shared/nativeAppPresets'
import log from './logger'

const SW_HIDE = 0
const SW_SHOWNOACTIVATE = 4
const HWND_TOPMOST = -1
const HWND_NOTOPMOST = -2
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const SWP_SHOWWINDOW = 0x0040

interface Win32Api {
  koffi: any
  EnumWindowsProc: any
  EnumWindows: (callback: unknown, lParam: number) => boolean
  GetWindowTextLengthW: (hwnd: number) => number
  GetWindowTextW: (hwnd: number, buffer: Buffer, maxCount: number) => number
  IsWindowVisible: (hwnd: number) => boolean
  IsWindow: (hwnd: number) => boolean
  GetWindowThreadProcessId: (hwnd: number, pid: Buffer) => number
  SetWindowPos: (
    hwnd: number,
    insertAfter: number,
    x: number,
    y: number,
    width: number,
    height: number,
    flags: number,
  ) => boolean
  ShowWindow: (hwnd: number, command: number) => boolean
}

interface NativeBinding {
  panelId: string
  hwnd: number
  title: string
  hostWindowId: number
  config: NativeAppConfig
  visible: boolean
  bounds?: NativeAppBounds
}

function expandEnv(candidate: string): string {
  return candidate.replace(/%([^%]+)%/g, (_match, name: string) => process.env[name] ?? '')
}

function normalizeTitlePattern(config: NativeAppConfig): string | undefined {
  return config.windowTitlePattern ?? getNativeAppPreset(config.presetId)?.titlePattern
}

function hwndToString(hwnd: number): string {
  return String(hwnd)
}

function hwndFromString(hwnd: string | undefined): number | null {
  if (!hwnd) return null
  const parsed = Number(hwnd)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function matchesPattern(title: string, pattern: string | undefined): boolean {
  if (!pattern) return false
  return title.toLowerCase().includes(pattern.toLowerCase())
}

function resolveExePath(config: NativeAppConfig): string | null {
  const direct = config.exePath ? expandEnv(config.exePath) : null
  if (direct && fs.existsSync(direct)) return direct

  const preset = getNativeAppPreset(config.presetId)
  for (const candidate of preset?.exeCandidates ?? []) {
    const expanded = expandEnv(candidate)
    if (expanded && fs.existsSync(expanded)) return expanded
  }

  return direct
}

function makeUnavailableStatus(panelId: string, error: string): NativeAppBindingStatus {
  return { panelId, visible: false, alive: false, error }
}

class NativeWindowHost {
  private api: Win32Api | null | undefined
  private lastInitFailureAt = 0
  private bindings = new Map<string, NativeBinding>()

  listWindows(): NativeAppWindowInfo[] {
    const api = this.getApi()
    if (!api) return []

    const windows: NativeAppWindowInfo[] = []
    const callback = api.koffi.register((hwnd: number) => {
      if (!api.IsWindowVisible(hwnd)) return true
      const title = this.getWindowTitle(api, hwnd)
      if (!title) return true
      const pid = this.getWindowProcessId(api, hwnd)
      windows.push({
        hwnd: hwndToString(hwnd),
        title,
        processId: pid,
        isBound: this.isHwndBound(hwnd),
      })
      return true
    }, api.koffi.pointer(api.EnumWindowsProc))

    try {
      api.EnumWindows(callback, 0)
    } finally {
      api.koffi.unregister(callback)
    }

    return windows.sort((a, b) => a.title.localeCompare(b.title))
  }

  async launch(request: NativeAppBindRequest, hostWindowId: number): Promise<NativeAppBindingStatus> {
    if (process.platform !== 'win32') {
      return makeUnavailableStatus(request.panelId, 'Native app panels are Windows-only in v1.')
    }

    const exePath = resolveExePath(request.config)
    if (!exePath) {
      return makeUnavailableStatus(request.panelId, 'Executable not found.')
    }

    try {
      const child = spawn(exePath, request.config.launchArgs ?? [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
      child.unref()
      const hwnd = await this.waitForWindow(child.pid, normalizeTitlePattern(request.config))
      if (!hwnd) return makeUnavailableStatus(request.panelId, 'Launched app, but no top-level window appeared.')
      return this.bind({ ...request, hwnd: hwndToString(hwnd) }, hostWindowId)
    } catch (error) {
      return makeUnavailableStatus(request.panelId, error instanceof Error ? error.message : String(error))
    }
  }

  async bind(request: NativeAppBindRequest, hostWindowId: number): Promise<NativeAppBindingStatus> {
    const api = this.getApi()
    if (!api) return makeUnavailableStatus(request.panelId, 'Native app panels are Windows-only in v1.')

    let hwnd = hwndFromString(request.hwnd)
    if (!hwnd) {
      const pattern = normalizeTitlePattern(request.config)
      const match = this.listWindows().find((win) => !win.isBound && matchesPattern(win.title, pattern))
      hwnd = hwndFromString(match?.hwnd)
    }
    if (!hwnd || !api.IsWindow(hwnd)) return makeUnavailableStatus(request.panelId, 'Window not found.')
    if (this.isHwndBound(hwnd, request.panelId)) {
      return makeUnavailableStatus(request.panelId, 'Window is already bound to another panel.')
    }

    const title = this.getWindowTitle(api, hwnd) || request.config.windowTitlePattern || 'Native App'
    const existing = this.bindings.get(request.panelId)
    if (existing && existing.hwnd !== hwnd) this.show(api, existing.hwnd, true)

    const binding: NativeBinding = {
      panelId: request.panelId,
      hwnd,
      title,
      hostWindowId,
      config: request.config,
      visible: true,
      bounds: existing?.bounds,
    }
    this.bindings.set(request.panelId, binding)
    if (binding.bounds) this.applyBounds(api, binding)
    this.show(api, hwnd, true)
    return this.statusFor(binding)
  }

  unbind(panelId: string): void {
    const binding = this.bindings.get(panelId)
    if (!binding) return
    const api = this.getApi()
    if (api && api.IsWindow(binding.hwnd)) this.releaseOverlay(api, binding.hwnd)
    this.bindings.delete(panelId)
  }

  setBounds(panelId: string, bounds: NativeAppBounds, hostWindowId: number): void {
    const api = this.getApi()
    const binding = this.bindings.get(panelId)
    if (!api || !binding) return
    binding.hostWindowId = hostWindowId
    binding.bounds = bounds
    this.applyBounds(api, binding)
  }

  setVisible(panelId: string, visible: boolean): void {
    const api = this.getApi()
    const binding = this.bindings.get(panelId)
    if (!api || !binding) return
    binding.visible = visible
    this.show(api, binding.hwnd, visible)
    if (visible && binding.bounds) this.applyBounds(api, binding)
  }

  getBinding(panelId: string): NativeAppBindingStatus | null {
    const binding = this.bindings.get(panelId)
    if (!binding) return null
    return this.statusFor(binding)
  }

  unbindForHostWindow(hostWindowId: number): void {
    for (const binding of this.bindings.values()) {
      if (binding.hostWindowId === hostWindowId) this.unbind(binding.panelId)
    }
  }

  private getApi(): Win32Api | null {
    if (process.platform !== 'win32') return null
    if (this.api) return this.api
    if (this.api === null && Date.now() - this.lastInitFailureAt < 2000) return null

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const koffi = require('koffi')
      koffi.pointer('HANDLE', koffi.opaque())
      const user32 = koffi.load('user32.dll')
      const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(intptr_t hwnd, long lParam)')
      this.api = {
        koffi,
        EnumWindowsProc,
        EnumWindows: user32.func('bool __stdcall EnumWindows(void *callback, intptr_t lParam)'),
        GetWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(intptr_t hwnd)'),
        GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, void *buffer, int maxCount)'),
        IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
        IsWindow: user32.func('bool __stdcall IsWindow(intptr_t hwnd)'),
        GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, void *pid)'),
        SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t insertAfter, int x, int y, int cx, int cy, uint flags)'),
        ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int command)'),
      }
    } catch (error) {
      log.error('[nativeApp] failed to initialize Win32 bridge:', error)
      this.api = null
      this.lastInitFailureAt = Date.now()
    }

    return this.api
  }

  private getWindowTitle(api: Win32Api, hwnd: number): string {
    const length = api.GetWindowTextLengthW(hwnd)
    if (length <= 0) return ''
    const buffer = Buffer.alloc((length + 1) * 2)
    api.GetWindowTextW(hwnd, buffer, length + 1)
    return buffer.toString('ucs2').replace(/\0+$/, '').trim()
  }

  private getWindowProcessId(api: Win32Api, hwnd: number): number {
    const buffer = Buffer.alloc(4)
    api.GetWindowThreadProcessId(hwnd, buffer)
    return buffer.readUInt32LE(0)
  }

  private isHwndBound(hwnd: number, exceptPanelId?: string): boolean {
    for (const binding of this.bindings.values()) {
      if (binding.hwnd === hwnd && binding.panelId !== exceptPanelId) return true
    }
    return false
  }

  private async waitForWindow(pid: number | undefined, pattern: string | undefined): Promise<number | null> {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const windows = this.listWindows()
      const match = windows.find((win) => (
        (!win.isBound && pid != null && win.processId === pid) ||
        (!win.isBound && matchesPattern(win.title, pattern))
      ))
      const hwnd = hwndFromString(match?.hwnd)
      if (hwnd) return hwnd
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return null
  }

  private applyBounds(api: Win32Api, binding: NativeBinding): void {
    if (!api.IsWindow(binding.hwnd) || !binding.bounds) return
    const bounds = binding.bounds
    api.SetWindowPos(
      binding.hwnd,
      HWND_TOPMOST,
      Math.round(bounds.x),
      Math.round(bounds.y),
      Math.max(1, Math.round(bounds.width)),
      Math.max(1, Math.round(bounds.height)),
      SWP_NOACTIVATE | SWP_SHOWWINDOW,
    )
  }

  private show(api: Win32Api, hwnd: number, visible: boolean): void {
    if (!api.IsWindow(hwnd)) return
    if (visible) {
      api.ShowWindow(hwnd, SW_SHOWNOACTIVATE)
      api.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)
    } else {
      api.ShowWindow(hwnd, SW_HIDE)
    }
  }

  private releaseOverlay(api: Win32Api, hwnd: number): void {
    api.ShowWindow(hwnd, SW_SHOWNOACTIVATE)
    api.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)
  }

  private statusFor(binding: NativeBinding): NativeAppBindingStatus {
    const api = this.getApi()
    const alive = !!api && api.IsWindow(binding.hwnd)
    return {
      panelId: binding.panelId,
      hwnd: hwndToString(binding.hwnd),
      title: binding.title,
      visible: binding.visible,
      alive,
    }
  }
}

export const nativeWindowHost = new NativeWindowHost()
