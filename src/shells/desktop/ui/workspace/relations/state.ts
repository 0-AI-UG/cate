// Client state of the relation UI: which relation's editor to open next and
// the waypoint of a chip being dragged (sent as one op when the drag ends).

import { create } from 'zustand'
import type { Point } from '@workspace/canvas/contract'

interface RelationUiState {
  editingRelationId: string | null
  waypointPreview: Record<string, Point>
  openRelationEditor(relationId: string | null): void
  previewWaypoint(relationId: string, point: Point | null): void
}

export const useRelationUi = create<RelationUiState>((set) => ({
  editingRelationId: null,
  waypointPreview: {},
  openRelationEditor: (editingRelationId) => set({ editingRelationId }),
  previewWaypoint: (relationId, point) => set((s) => {
    const next = { ...s.waypointPreview }
    if (point) next[relationId] = point
    else delete next[relationId]
    return { waypointPreview: next }
  }),
}))
