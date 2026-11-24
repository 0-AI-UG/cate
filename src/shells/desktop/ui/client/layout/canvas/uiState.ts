// Canvas UI state of this client that is not tied to one canvas: the active
// tool, worktree hover and focus lens, and the minimap pill.

import { create } from 'zustand'
import type { CanvasCorner } from './parts/corners'

export type CanvasTool = 'select' | 'hand'

interface CanvasUiState {
  activeTool: CanvasTool
  /** Worktree under the pointer in a worktree menu or chip. */
  hoveredWorktreeId: string | null
  /** A worktree previewed on one panel while its picker menu is open. */
  previewWorktree: { panelId: string; worktreeId: string } | null
  /** The focus lens: nodes of other worktrees recede. */
  focusedWorktreeId: string | null
  /** Panel a sidebar thread row points at: its canvas node lights up. */
  peekedPanelId: string | null
  /** The peek was committed by a click: the view stays where it went. */
  peekKeepView: boolean
  minimapOpen: Record<string, boolean>
  minimapCorner: CanvasCorner
  setActiveTool(tool: CanvasTool): void
  setHoveredWorktree(id: string | null): void
  setPreviewWorktree(preview: { panelId: string; worktreeId: string } | null): void
  setPeekedPanel(id: string | null, keepView?: boolean): void
  setFocusedWorktree(id: string | null): void
  clearWorktreeLens(): void
  toggleMinimap(canvasId: string): void
  setMinimapCorner(corner: CanvasCorner): void
}

export const useCanvasUi = create<CanvasUiState>((set) => ({
  activeTool: 'select',
  hoveredWorktreeId: null,
  previewWorktree: null,
  focusedWorktreeId: null,
  peekedPanelId: null,
  peekKeepView: false,
  minimapOpen: {},
  minimapCorner: 'bottom-right',
  setActiveTool: (activeTool) => set({ activeTool }),
  setHoveredWorktree: (hoveredWorktreeId) => set({ hoveredWorktreeId }),
  setPreviewWorktree: (previewWorktree) => set({ previewWorktree }),
  setPeekedPanel: (peekedPanelId, keepView = false) => set({ peekedPanelId, peekKeepView: keepView }),
  setFocusedWorktree: (focusedWorktreeId) => set({ focusedWorktreeId }),
  clearWorktreeLens: () => set({ focusedWorktreeId: null }),
  toggleMinimap: (canvasId) => set((s) => ({ minimapOpen: { ...s.minimapOpen, [canvasId]: !s.minimapOpen[canvasId] } })),
  setMinimapCorner: (minimapCorner) => set({ minimapCorner }),
}))
