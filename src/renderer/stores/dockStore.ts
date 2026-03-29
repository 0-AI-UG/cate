// =============================================================================
// Dock Store — Zustand state for the modular dock zone system.
// =============================================================================

import { create } from 'zustand'
import type { DockZonePosition, DockZoneState, DockLayoutState } from '../../shared/types'
import { DOCK_ZONE_DEFAULTS } from '../../shared/types'

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function createDefaultZone(position: DockZonePosition): DockZoneState {
  return {
    position,
    panelIds: [],
    activePanelIndex: 0,
    size: DOCK_ZONE_DEFAULTS[position].size,
    collapsed: false,
  }
}

function createDefaultLayout(): DockLayoutState {
  return {
    zones: {
      left: createDefaultZone('left'),
      right: createDefaultZone('right'),
      bottom: createDefaultZone('bottom'),
    },
  }
}

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

interface DockStoreState {
  zones: Record<DockZonePosition, DockZoneState>
}

interface DockStoreActions {
  dockPanel: (panelId: string, zone: DockZonePosition, index?: number) => void
  undockPanel: (panelId: string) => DockZonePosition | null
  reorderTab: (zone: DockZonePosition, fromIndex: number, toIndex: number) => void
  setActiveTab: (zone: DockZonePosition, index: number) => void
  resizeZone: (zone: DockZonePosition, size: number) => void
  toggleZoneCollapse: (zone: DockZonePosition) => void
  setZoneCollapsed: (zone: DockZonePosition, collapsed: boolean) => void
  getPanelZone: (panelId: string) => DockZonePosition | null
  removePanelFromZones: (panelId: string) => void
  loadDockLayout: (layout: DockLayoutState) => void
  serialize: () => DockLayoutState
  reset: () => void
}

export type DockStore = DockStoreState & DockStoreActions

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useDockStore = create<DockStore>((set, get) => ({
  zones: createDefaultLayout().zones,

  dockPanel(panelId, zone, index?) {
    // First remove from any existing zone
    get().removePanelFromZones(panelId)

    set((state) => {
      const zoneState = state.zones[zone]
      const newPanelIds = [...zoneState.panelIds]
      const insertIndex = index ?? newPanelIds.length
      newPanelIds.splice(insertIndex, 0, panelId)

      return {
        zones: {
          ...state.zones,
          [zone]: {
            ...zoneState,
            panelIds: newPanelIds,
            activePanelIndex: insertIndex,
            collapsed: false, // auto-expand when docking
          },
        },
      }
    })
  },

  undockPanel(panelId) {
    const zone = get().getPanelZone(panelId)
    if (!zone) return null

    set((state) => {
      const zoneState = state.zones[zone]
      const newPanelIds = zoneState.panelIds.filter((id) => id !== panelId)
      const newActiveIndex = Math.min(zoneState.activePanelIndex, Math.max(0, newPanelIds.length - 1))

      return {
        zones: {
          ...state.zones,
          [zone]: {
            ...zoneState,
            panelIds: newPanelIds,
            activePanelIndex: newActiveIndex,
          },
        },
      }
    })

    return zone
  },

  reorderTab(zone, fromIndex, toIndex) {
    set((state) => {
      const zoneState = state.zones[zone]
      const newPanelIds = [...zoneState.panelIds]
      const [moved] = newPanelIds.splice(fromIndex, 1)
      newPanelIds.splice(toIndex, 0, moved)

      // Keep the same panel active
      let newActiveIndex = zoneState.activePanelIndex
      if (zoneState.activePanelIndex === fromIndex) {
        newActiveIndex = toIndex
      } else if (fromIndex < zoneState.activePanelIndex && toIndex >= zoneState.activePanelIndex) {
        newActiveIndex--
      } else if (fromIndex > zoneState.activePanelIndex && toIndex <= zoneState.activePanelIndex) {
        newActiveIndex++
      }

      return {
        zones: {
          ...state.zones,
          [zone]: {
            ...zoneState,
            panelIds: newPanelIds,
            activePanelIndex: newActiveIndex,
          },
        },
      }
    })
  },

  setActiveTab(zone, index) {
    set((state) => ({
      zones: {
        ...state.zones,
        [zone]: {
          ...state.zones[zone],
          activePanelIndex: Math.max(0, Math.min(index, state.zones[zone].panelIds.length - 1)),
        },
      },
    }))
  },

  resizeZone(zone, size) {
    const { minSize } = DOCK_ZONE_DEFAULTS[zone]
    const clampedSize = Math.max(minSize, size)

    set((state) => ({
      zones: {
        ...state.zones,
        [zone]: {
          ...state.zones[zone],
          size: clampedSize,
        },
      },
    }))
  },

  toggleZoneCollapse(zone) {
    set((state) => ({
      zones: {
        ...state.zones,
        [zone]: {
          ...state.zones[zone],
          collapsed: !state.zones[zone].collapsed,
        },
      },
    }))
  },

  setZoneCollapsed(zone, collapsed) {
    set((state) => ({
      zones: {
        ...state.zones,
        [zone]: {
          ...state.zones[zone],
          collapsed,
        },
      },
    }))
  },

  getPanelZone(panelId) {
    const { zones } = get()
    for (const position of ['left', 'right', 'bottom'] as DockZonePosition[]) {
      if (zones[position].panelIds.includes(panelId)) {
        return position
      }
    }
    return null
  },

  removePanelFromZones(panelId) {
    set((state) => {
      const newZones = { ...state.zones }
      let changed = false

      for (const position of ['left', 'right', 'bottom'] as DockZonePosition[]) {
        const zone = newZones[position]
        if (zone.panelIds.includes(panelId)) {
          const newPanelIds = zone.panelIds.filter((id) => id !== panelId)
          newZones[position] = {
            ...zone,
            panelIds: newPanelIds,
            activePanelIndex: Math.min(zone.activePanelIndex, Math.max(0, newPanelIds.length - 1)),
          }
          changed = true
        }
      }

      return changed ? { zones: newZones } : state
    })
  },

  loadDockLayout(layout) {
    set({ zones: layout.zones })
  },

  serialize() {
    return { zones: { ...get().zones } }
  },

  reset() {
    set({ zones: createDefaultLayout().zones })
  },
}))
