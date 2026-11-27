// The draw tool's settings on this client (the pen, its colour and width,
// dashes, fill) and the drawing session: the drawing panel the strokes go
// into until the tool is put away. In memory only.

import { create } from 'zustand'

export type DrawTool = 'pen' | 'highlighter' | 'arrow' | 'line' | 'rect' | 'ellipse' | 'eraser'

export const DRAW_COLORS = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#0A84FF', '#BF5AF2', '#FFFFFF', '#1C1C1E'] as const

export const DRAW_WIDTH_MIN = 1
export const DRAW_WIDTH_MAX = 32

/** A highlighter is this many times wider than the pen width. */
export const HIGHLIGHTER_SCALE = 4

export interface DrawSession { workspaceId: string; canvasId: string; panelId: string }

interface DrawState {
  tool: DrawTool
  color: string
  width: number
  dashed: boolean
  filled: boolean
  session: DrawSession | null
  setTool(tool: DrawTool): void
  setColor(color: string): void
  setWidth(width: number): void
  toggleDashed(): void
  toggleFilled(): void
  setSession(session: DrawSession | null): void
}

export const useDrawState = create<DrawState>((set) => ({
  tool: 'pen',
  color: DRAW_COLORS[0],
  width: 3,
  dashed: false,
  filled: false,
  session: null,
  setTool: (tool) => set({ tool }),
  setColor: (color) => set({ color }),
  setWidth: (width) => set({ width: Math.min(DRAW_WIDTH_MAX, Math.max(DRAW_WIDTH_MIN, Math.round(width))) }),
  toggleDashed: () => set((s) => ({ dashed: !s.dashed })),
  toggleFilled: () => set((s) => ({ filled: !s.filled })),
  setSession: (session) => set({ session }),
}))
