import { BrowserWindow } from 'electron'
import { clampGhostSize, ghostPosition } from '../dragLogic'
import { getSharedPanelDef } from '../../shared/panels'

// =============================================================================
// Drag ghost window — a tiny borderless always-on-top window that follows the
// cursor during cross-window drags so the user has visual feedback outside any
// app window.
// =============================================================================

let dragGhostWin: BrowserWindow | null = null

export function createDragGhostWindow(
  panelType: string,
  panelTitle: string,
  ghostWidth: number,
  ghostHeight: number,
): void {
  if (dragGhostWin && !dragGhostWin.isDestroyed()) {
    dragGhostWin.destroy()
  }

  // Clamp ghost size to sane bounds so we don't spawn a massive native window.
  const { width: w, height: h } = clampGhostSize(ghostWidth, ghostHeight)

  dragGhostWin = new BrowserWindow({
    width: w,
    height: h,
    frame: false,
    // Let CSS round the ghost; native window corners clip its border.
    roundedCorners: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  // Tag this window so the cursor-poll loop can exclude it when deciding
  // whether the cursor is over a Cate window.
  ;(dragGhostWin as unknown as { __isDragGhost: boolean }).__isDragGhost = true

  // Ignore mouse events so the ghost doesn't interfere with drop targets
  dragGhostWin.setIgnoreMouseEvents(true)

  const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
  const icon = getSharedPanelDef(panelType).ghostSvg
  const safeTitle = escapeHtml(panelTitle.slice(0, 40))
  const html = `data:text/html;charset=utf-8,<!DOCTYPE html>
<html><head><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:transparent;overflow:hidden;font:11px -apple-system,sans-serif}
.ghost{width:100vw;height:100vh;display:flex;flex-direction:column;
 border:1.5px solid rgba(74,158,255,0.7);background:rgba(74,158,255,0.08);
 border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);overflow:hidden}
.tbar{height:24px;flex:0 0 24px;display:flex;align-items:center;gap:6px;
 padding:0 10px;background:rgba(42,42,58,0.95);
 border-bottom:1px solid rgba(255,255,255,0.08);
 color:rgba(255,255,255,0.85);font-weight:500;white-space:nowrap;overflow:hidden}
.tbar svg{flex-shrink:0}
.tbar .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.body{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:16px}
.body .big{opacity:0.9}
.body .lbl{color:rgba(74,158,255,0.85);font-size:11px;font-weight:500}
</style></head><body><div class="ghost"><div class="tbar">${icon}<span class="t">${safeTitle}</span></div><div class="body"><div class="big"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(74,158,255,0.85)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg></div><div class="lbl">Drop to place here</div></div></div></body></html>`

  dragGhostWin.loadURL(html)
  dragGhostWin.webContents.once('did-finish-load', () => {
    if (dragGhostWin && !dragGhostWin.isDestroyed()) {
      dragGhostWin.showInactive()
    }
  })
}

export function moveDragGhostWindow(
  screenX: number,
  screenY: number,
  grabOffsetX?: number,
  grabOffsetY?: number,
): void {
  if (dragGhostWin && !dragGhostWin.isDestroyed()) {
    const grab = grabOffsetX != null || grabOffsetY != null
      ? { x: grabOffsetX ?? 12, y: grabOffsetY ?? 12 }
      : null
    const pos = ghostPosition({ x: screenX, y: screenY }, grab)
    dragGhostWin.setPosition(pos.x, pos.y, false)
  }
}

export function destroyDragGhostWindow(): void {
  if (dragGhostWin && !dragGhostWin.isDestroyed()) {
    dragGhostWin.destroy()
  }
  dragGhostWin = null
}

/** True when the ghost window currently exists and is visible. */
export function isDragGhostVisible(): boolean {
  return !!(dragGhostWin && !dragGhostWin.isDestroyed() && dragGhostWin.isVisible())
}

/** The live ghost BrowserWindow, or null. Kept narrow for the cross-window
 *  poll loop which toggles its visibility based on cursor position. */
export function getDragGhostWindow(): BrowserWindow | null {
  if (dragGhostWin && !dragGhostWin.isDestroyed()) return dragGhostWin
  return null
}
