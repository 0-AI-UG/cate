// The drag ghost: a small borderless always-on-top window that follows the
// cursor while a panel is dragged outside every app window.

import { BrowserWindow } from 'electron'
import type { DragPayload } from '../contract'
import type { DragGhost } from './crossWindowDrag'

const MIN = { width: 200, height: 80 }
const MAX = { width: 800, height: 600 }
const DEFAULT = { width: 320, height: 200 }
const GRAB = { x: 12, y: 12 }

export function clampGhostSize(width: number | undefined, height: number | undefined): { width: number; height: number } {
  return {
    width: Math.round(Math.max(MIN.width, Math.min(MAX.width, width || DEFAULT.width))),
    height: Math.round(Math.max(MIN.height, Math.min(MAX.height, height || DEFAULT.height))),
  }
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function ghostHtml(payload: DragPayload): string {
  // Only an inline <svg> is embedded.
  const icon = typeof payload.iconSvg === 'string' && /^<svg[\s>]/.test(payload.iconSvg) ? payload.iconSvg : ''
  const title = escapeHtml(String(payload.title ?? '').slice(0, 40))
  return `<!DOCTYPE html><html><head><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:transparent;overflow:hidden;font:11px -apple-system,sans-serif}
.ghost{width:100vw;height:100vh;display:flex;flex-direction:column;border:1.5px solid rgba(74,158,255,0.7);background:rgba(74,158,255,0.08);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);overflow:hidden}
.tbar{height:24px;flex:0 0 24px;display:flex;align-items:center;gap:6px;padding:0 10px;background:rgba(42,42,58,0.95);border-bottom:1px solid rgba(255,255,255,0.08);color:rgba(255,255,255,0.85);font-weight:500;white-space:nowrap;overflow:hidden}
.tbar svg{flex-shrink:0}.tbar .t{overflow:hidden;text-overflow:ellipsis}
.body{flex:1;display:flex;align-items:center;justify-content:center;color:rgba(74,158,255,0.85);font-weight:500}
</style></head><body><div class="ghost"><div class="tbar">${icon}<span class="t">${title}</span></div><div class="body">Drop to place here</div></div></body></html>`
}

export function createDragGhost(): DragGhost {
  let win: BrowserWindow | null = null
  const live = () => (win && !win.isDestroyed() ? win : null)
  return {
    show(payload) {
      live()?.destroy()
      const size = clampGhostSize(payload.size?.width, payload.size?.height)
      const next = new BrowserWindow({
        ...size,
        frame: false,
        roundedCorners: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        resizable: false,
        focusable: false,
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, javascript: false },
      })
      next.setIgnoreMouseEvents(true)
      void next.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(ghostHtml(payload))}`)
      next.webContents.once('did-finish-load', () => { if (!next.isDestroyed()) next.showInactive() })
      win = next
    },
    move(x, y) {
      live()?.setPosition(Math.round(x - GRAB.x), Math.round(y - GRAB.y), false)
    },
    setVisible(visible) {
      const current = live()
      if (!current) return
      if (visible && !current.isVisible()) current.showInactive()
      else if (!visible && current.isVisible()) current.hide()
    },
    destroy() {
      live()?.destroy()
      win = null
    },
  }
}
