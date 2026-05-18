// =============================================================================
// Update Store — tracks auto-updater status pushed from the main process.
// The CanvasToolbar reads this to render a subtle blue "update" pill next to
// the minimap button when a new version is available.
// =============================================================================

import { create } from 'zustand'

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; canAutoInstall: boolean; releaseUrl?: string }
  | { state: 'downloading'; version: string; percent?: number }
  | { state: 'downloaded'; version: string }
  | { state: 'manual'; version: string; releaseUrl: string }
  | { state: 'error'; message: string }

interface UpdateStore {
  status: UpdateStatus
  setStatus: (status: UpdateStatus) => void
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  status: { state: 'idle' },
  setStatus(status) {
    set({ status })
  },
}))
