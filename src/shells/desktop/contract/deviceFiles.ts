// Device documents under Electron's userData (architecture 16). Main is their
// only writer; the renderer reaches the shared ones as a `DeviceStore` over IPC.

/** Documents the renderer may read, write and subscribe to by name. A name is
 *  the file's base name without `.json` (`workspaces` is `workspaces.json`). */
export const SHARED_DEVICE_DOCUMENTS = ['settings', 'ui-state', 'boot', 'workspaces', 'known-runtimes'] as const

export type SharedDeviceDocument = (typeof SHARED_DEVICE_DOCUMENTS)[number]

/** Main-only files: the device key, updater and analytics state, the install id. */
export const PRIVATE_DEVICE_FILES = {
  deviceKey: 'device-key.json',
  updateState: 'update-state.json',
  analyticsState: 'analytics-state.json',
  pendingEvents: 'pending-events.jsonl',
  installId: 'install-id',
} as const

export const CANVAS_BACKGROUNDS_DIR = 'canvas-backgrounds'

/** The canonical document name, or null when the renderer may not use it. */
export function sharedDeviceDocument(name: unknown): SharedDeviceDocument | null {
  return typeof name === 'string' && (SHARED_DEVICE_DOCUMENTS as readonly string[]).includes(name) ? (name as SharedDeviceDocument) : null
}

/** `boot.json`: read synchronously at launch, before any window exists. */
export interface BootSnapshot {
  /** Main window bounds (main writes them). */
  geometry?: { x: number; y: number; width: number; height: number }
  /** Detached window bounds on this device, by `<workspaceId>/<windowId>`
   *  (main writes them). A detached window's position is never shared. */
  detachedGeometry?: Record<string, { x: number; y: number; width: number; height: number }>
  /** Theme boot cache (main writes it from the client settings). */
  theme?: string
  backgroundColor?: string
  appearance?: 'dark' | 'light' | 'system'
  /** The workspace the main window showed last (the renderer writes it). */
  lastWorkspace?: string
}

/** Fields of `boot.json` only main writes; a renderer `set` keeps them. */
export const MAIN_OWNED_BOOT_FIELDS = ['geometry', 'detachedGeometry', 'theme', 'backgroundColor', 'appearance'] as const
