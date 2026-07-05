// =============================================================================
// extensionsStore — a thin renderer-side mirror of the main process's extension
// registry. The settings UI manages extensions through its own local fetches;
// this store exists so chrome that lives outside settings (the canvas toolbar's
// extensions button) can react to the enabled-extension set without each mount
// opening its own IPC subscription.
//
// One module-level subscription (started lazily via ensureExtensionsStarted)
// keeps the list fresh on every EXTENSIONS_CHANGED broadcast.
// =============================================================================

import { create } from 'zustand'
import type { ExtensionListEntry } from '../../shared/extensions'

interface ExtensionsState {
  entries: ExtensionListEntry[]
  refresh: () => Promise<void>
}

export const useExtensionsStore = create<ExtensionsState>((set) => ({
  entries: [],
  refresh: async () => {
    try {
      set({ entries: await window.electronAPI.extensionList() })
    } catch {
      /* ignore — the list just stays as-is */
    }
  },
}))

let started = false

/** Load the extension list once and keep it in sync with main. Safe to call
 *  from every component that reads the store; only the first call wires up. */
export function ensureExtensionsStarted(): void {
  if (started) return
  started = true
  void useExtensionsStore.getState().refresh()
  window.electronAPI.onExtensionsChanged(() => void useExtensionsStore.getState().refresh())
}

export interface ExtensionPanelTarget {
  extensionId: string
  extensionName: string
  panelId: string
  panelLabel: string
}

/** Flatten enabled+installed extensions into one openable panel target per
 *  declared panel — what the toolbar offers to open. */
export function enabledPanelTargets(entries: ExtensionListEntry[]): ExtensionPanelTarget[] {
  const targets: ExtensionPanelTarget[] = []
  for (const e of entries) {
    if (!e.enabled || !e.installed) continue
    for (const p of e.manifest.panels) {
      targets.push({
        extensionId: e.manifest.id,
        extensionName: e.manifest.name,
        panelId: p.id,
        panelLabel: p.label,
      })
    }
  }
  return targets
}
