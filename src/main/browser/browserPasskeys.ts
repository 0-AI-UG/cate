import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { createRequire } from 'node:module'
import path from 'node:path'
import { browserRuntime } from './browserRuntime'
import { validatePasskeyRequest } from './passkeyPolicy'
import { passkeyAttestationFields } from './passkeyAttestation'
import log from '../logger'

interface NativePasskeys {
  isAvailable(): boolean
  request(json: string, windowHandle: Buffer): Promise<string>
  cancel(id: string): void
}

export function registerBrowserPasskeys(): void {
  let native: NativePasskeys | undefined
  const version = process.platform === 'darwin' ? process.getSystemVersion().split('.').map(Number) : []
  if (version[0] > 14 || (version[0] === 14 && version[1] >= 4)) {
    try {
      const file = app.isPackaged ? path.join(process.resourcesPath, 'passkeys.node')
        : path.join(app.getAppPath(), 'dist-native/passkeys.node')
      native = createRequire(import.meta.url)(file) as NativePasskeys
      if (!native.isAvailable()) native = undefined
    } catch (error) {
      log.info('[passkeys] Native browser passkeys unavailable: %s', error instanceof Error ? error.message : String(error))
    }
  }
  const pending = new Map<number, { id: string; cancel(): void }>()
  const isGuest = (event: IpcMainEvent | IpcMainInvokeEvent) => event.sender.getType() === 'webview'
    && event.senderFrame === event.sender.mainFrame

  // This synchronous boolean is used only while installing the guest preload;
  // unsupported/unsigned builds retain Chromium's original WebAuthn methods.
  ipcMain.on('cate-passkeys-available', (event) => {
    event.returnValue = Boolean(native && isGuest(event))
  })
  ipcMain.on('cate-passkeys-cancel', (event, id: unknown) => {
    if (!isGuest(event)) return
    const request = pending.get(event.sender.id)
    if (typeof id === 'string' && request?.id === id) request.cancel()
  })
  ipcMain.handle('cate-passkeys-request', async (event, input: unknown) => {
    const contents = event.sender
    if (!native || !isGuest(event) || !browserRuntime.isRegistered(contents.id)
      || !contents.isFocused() || pending.has(contents.id)) return { error: 'NotAllowedError' }
    const frame = event.senderFrame!
    const owner = BrowserWindow.fromWebContents(contents)
    if (!owner || owner.isDestroyed() || !owner.isVisible()) return { error: 'NotAllowedError' }
    try {
      if (!input || typeof input !== 'object' || JSON.stringify(input).length > 1048576) throw new TypeError('Invalid request')
      const { id, operation, options } = input as Record<string, any>
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new TypeError('Invalid request ID')
      const origin = new URL(frame.url).origin
      const validated = validatePasskeyRequest(operation, options, origin)
      let cancelled = false
      const cancel = () => { cancelled = true; native!.cancel(id) }
      const onNavigation = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => { if (mainFrame) cancel() }
      contents.on('did-start-navigation', onNavigation)
      contents.once('destroyed', cancel)
      owner.once('closed', cancel)
      pending.set(contents.id, { id, cancel })
      const timeout = typeof validated.timeout === 'number' && Number.isFinite(validated.timeout)
        ? Math.max(1, Math.min(validated.timeout, 120000)) : 60000
      const timer = setTimeout(cancel, timeout)
      try {
        const result = JSON.parse(await native.request(JSON.stringify({ id, operation, options: validated, origin }), owner.getNativeWindowHandle()))
        if (cancelled || contents.isDestroyed() || frame.isDestroyed() || new URL(frame.url).origin !== origin) return { error: 'AbortError' }
        if (result.response?.attestationObject) Object.assign(result.response, passkeyAttestationFields(result.response.attestationObject))
        if (!validated.extensions?.credProps) delete result.clientExtensionResults?.credProps
        return result
      } finally {
        clearTimeout(timer)
        pending.delete(contents.id)
        contents.removeListener('did-start-navigation', onNavigation)
        contents.removeListener('destroyed', cancel)
        owner.removeListener('closed', cancel)
      }
    } catch (error) {
      return { error: error instanceof DOMException ? error.name : error instanceof TypeError ? 'TypeError' : 'NotAllowedError' }
    }
  })
}
