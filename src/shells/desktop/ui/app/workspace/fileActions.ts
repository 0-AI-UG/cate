// Opening workspace files and terminals from file views, the palette and
// drops: a panel already showing the file is revealed, else a new one opens
// next to the focused panel (or on the active canvas).

import type { PanelPlacementOptions } from '@panels/framework/contract'
import { tryRuntimeFor } from '@kernel/rpc/client'
import { createPanel, createPanelFrom, focusedPanelId, panelShowingFile, panelTypeOpening, revealPanel } from '@client/host'
import { activeCanvasId, createPanelOnCanvas } from '../../client/layout/canvas'
import type { FileLineLocation } from '@workspace/files/contract'
import type { FileViewsHost } from '../../workspace/files'

/** Opens one file in the type that `opens` files, reusing one already
 *  working on `path`; returns the editor panel. */
export function openFile(workspaceId: string, path: string, placement: PanelPlacementOptions & { canvas?: boolean } = {}): string | null {
  const type = panelTypeOpening('file')
  if (!type) return null
  const existing = panelShowingFile(workspaceId, type, path)
  if (existing) {
    void revealPanel(workspaceId, existing)
    return existing
  }
  const { canvas, ...rest } = placement
  const canvasId = canvas ? activeCanvasId(workspaceId) : null
  if (canvasId) return createPanelOnCanvas(workspaceId, canvasId, type, { filePath: path })
  return createPanel(workspaceId, type, { near: focusedPanelId(workspaceId) ?? undefined, ...rest, filePath: path })
}

/** Opens dropped files; a dropped search match (`location`) opens at its line. */
export function openDroppedFiles(
  workspaceId: string,
  paths: string[],
  placement: PanelPlacementOptions,
  location?: FileLineLocation | null,
): void {
  for (const path of paths) {
    const panelId = openFile(workspaceId, path, placement)
    if (panelId && location && location.path === path) revealLine(workspaceId, panelId, path, location.line, location.column)
  }
}

/** Moves a file panel to a line (1-based column) through its session. */
export function revealLine(workspaceId: string, panelId: string, path: string, line: number, column = 1): void {
  const runtime = tryRuntimeFor(workspaceId)
  void runtime?.session.op({ panelId, op: { kind: 'openFile', path, line, column } }).catch(() => {})
}

/** Opens a terminal in `cwd`; one a panel asked for goes through that
 *  panel's placement flow. */
export function openTerminal(workspaceId: string, cwd: string, fromPanelId?: string): void {
  const type = panelTypeOpening('directory')
  if (!type) return
  if (fromPanelId) void createPanelFrom(workspaceId, fromPanelId, type, { cwd })
  else createPanel(workspaceId, type, { cwd, near: focusedPanelId(workspaceId) ?? undefined })
}

export const fileViewsHost: FileViewsHost = {
  openFiles(workspaceId, paths, mode = 'dock') {
    for (const path of paths) openFile(workspaceId, path, { canvas: mode === 'canvas' })
  },
  openMatch(workspaceId, path, line, column) {
    const panelId = openFile(workspaceId, path)
    if (panelId) revealLine(workspaceId, panelId, path, line, column)
  },
  openTerminal,
}
