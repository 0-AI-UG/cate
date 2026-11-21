import { app } from 'electron'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createLogger } from '@kernel/log/contract'
import { validatePasskeyRequest } from './passkeyPolicy'
import { passkeyAttestationFields } from './passkeyAttestation'

// Passkeys (architecture 10.2): the native addon (`native/passkeys`) asks the
// OS, which keeps passkeys in the user's keychain; Cate never stores them. It
// needs macOS 14.4+, the signed app's entitlement and a window, so the shell
// declares the `passkeys` client feature only when this reports available.

const log = createLogger('passkeys')

interface NativePasskeys {
  isAvailable(): boolean
  request(json: string, windowHandle: Buffer): Promise<string>
  cancel(id: string): void
}

/** The addon's path: next to the app resources when packaged, else the dev build. */
export function passkeysAddonPath(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'passkeys.node')
    : path.join(app.getAppPath(), 'dist-native/passkeys.node')
}

function loadNativePasskeys(): NativePasskeys | undefined {
  let native: NativePasskeys | undefined
  const version = process.platform === 'darwin' ? process.getSystemVersion().split('.').map(Number) : []
  if (version[0] > 14 || (version[0] === 14 && version[1] >= 4)) {
    try {
      native = createRequire(import.meta.url)(passkeysAddonPath()) as NativePasskeys
      if (!native.isAvailable()) native = undefined
    } catch (error) {
      log.info('native browser passkeys unavailable: %s', error instanceof Error ? error.message : String(error))
    }
  }
  return native
}

/** Native passkey requests relayed by the isolated engine. The engine pins
 *  origin/frame and user focus; this side owns the real OS parent window. */
export function createEnginePasskeys(deps: { owner(id: number): Electron.BrowserWindow | null }) {
  const native = loadNativePasskeys()
  const pending = new Map<number, { id: string; cancel(): void }>()
  return {
    available: !!native,
    cancel(webContentsId: number, id: string) {
      const request = pending.get(webContentsId)
      if (request?.id === id) request.cancel()
    },
    cancelAll() { for (const request of pending.values()) request.cancel() },
    async request(webContentsId: number, origin: string, input: unknown) {
      const owner = deps.owner(webContentsId)
      if (!native || !owner || owner.isDestroyed() || !owner.isVisible() || !owner.isFocused() || pending.has(webContentsId)) return { error: 'NotAllowedError' }
      try {
        if (!input || typeof input !== 'object' || JSON.stringify(input).length > 1048576) throw new TypeError('Invalid request')
        const { id, operation, options } = input as Record<string, any>
        if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new TypeError('Invalid request ID')
        const validated = validatePasskeyRequest(operation, options, origin)
        let cancelled = false
        const cancel = () => { cancelled = true; native.cancel(id) }
        pending.set(webContentsId, { id, cancel })
        owner.once('closed', cancel)
        const timer = setTimeout(cancel, typeof validated.timeout === 'number' && Number.isFinite(validated.timeout) ? Math.max(1, Math.min(validated.timeout, 120000)) : 60000)
        try {
          const result = JSON.parse(await native.request(JSON.stringify({ id, operation, options: validated, origin }), owner.getNativeWindowHandle()))
          if (cancelled || owner.isDestroyed()) return { error: 'AbortError' }
          if (result.response?.attestationObject) Object.assign(result.response, passkeyAttestationFields(result.response.attestationObject))
          if (!validated.extensions?.credProps) delete result.clientExtensionResults?.credProps
          return result
        } finally {
          clearTimeout(timer); pending.delete(webContentsId); owner.removeListener('closed', cancel)
        }
      } catch (error) {
        return { error: error instanceof DOMException ? error.name : error instanceof TypeError ? 'TypeError' : 'NotAllowedError' }
      }
    },
  }
}
