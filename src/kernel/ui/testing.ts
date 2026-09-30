import { vi } from 'vitest'
import type { ClientUi } from './contract'
import { installClientUi } from './clientUi'

/** Installs an inert ClientUi of vi.fn()s (dialogs cancel, pickers pick
 * nothing), including every feature-gated method. Pass overrides to script
 * answers or to add methods feature modules declare. Returns the installed mock. */
export function installMockClientUi<T extends Partial<ClientUi>>(overrides: T = {} as T) {
  const ui = {
    openExternal: vi.fn(),
    openSettings: vi.fn(),
    confirm: vi.fn(async () => false),
    showError: vi.fn(),
    confirmUnsavedChanges: vi.fn(async () => 'cancel' as const),
    saveFileDialog: vi.fn(async () => null),
    fileApps: vi.fn(async () => []),
    openFile: vi.fn(async () => {}),
    revealFile: vi.fn(async () => {}),
    openFileOnGitHub: vi.fn(async () => {}),
    writeClipboard: vi.fn(async () => {}),
    notify: vi.fn(),
    ...overrides,
  }
  installClientUi(ui as ClientUi)
  return ui
}
