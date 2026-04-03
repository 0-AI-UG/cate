// =============================================================================
// Cross-window drag-and-drop IPC handlers
//
// Uses Electron native drag-and-drop (webContents.startDrag() + HTML5 events)
// as the transport layer. The OS handles cursor tracking, multi-monitor DPI,
// and window hit-testing natively.
//
// Note: The actual IPC handlers are registered in index.ts alongside the
// panel transfer handlers, since they need access to createWindow().
// This file exports helper utilities for the drag system.
import log from '../logger'
// =============================================================================

import { app, nativeImage } from 'electron'
import path from 'path'
import fs from 'fs'
import type { PanelTransferSnapshot } from '../../shared/types'

// Temp file for drag data — cleaned up on drag end
let dragTempFile: string | null = null

/**
 * Write the transfer snapshot to a temp file for OS drag.
 * Returns the temp file path.
 */
export function writeDragTempFile(snapshot: PanelTransferSnapshot): string {
  const tempDir = app.getPath('temp')
  dragTempFile = path.join(tempDir, `cate-drag-${Date.now()}.json`)
  try {
    fs.writeFileSync(dragTempFile, JSON.stringify(snapshot), 'utf-8')
  } catch (error) {
    log.error('[writeDragTempFile]', error)
    throw error instanceof Error ? error : new Error(String(error))
  }
  return dragTempFile
}

/**
 * Clean up the temp file created for an OS drag.
 */
export function cleanupDragTempFile(): void {
  if (dragTempFile) {
    try { fs.unlinkSync(dragTempFile) } catch { /* ignore */ }
    dragTempFile = null
  }
}

/**
 * Create a minimal drag ghost NativeImage.
 * The actual visual ghost is rendered by the renderer's DragGhost component.
 */
export function createDragGhostImage(): Electron.NativeImage {
  return nativeImage.createFromBuffer(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    ),
  )
}

/**
 * Register drag-related IPC handlers.
 * Called from registerAllHandlers() in index.ts.
 */
export function registerHandlers(): void {
  // Drag handlers are registered inline in index.ts because they need
  // access to createWindow(). This function is a no-op placeholder that
  // keeps the import pattern consistent with other IPC modules.
}
