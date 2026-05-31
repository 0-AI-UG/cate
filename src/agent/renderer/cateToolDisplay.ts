// =============================================================================
// Presentation mapping for cate-control tool calls — turns an (action, params)
// pair into an icon + human-readable verb + short summary. Shared by the
// in-thread CateToolCard and the guarded-mode ApprovalCard so the agent panel
// renders Cate's canvas actions as compact custom cards instead of raw JSON.
// Pure (no React/DOM) beyond the icon component references.
// =============================================================================

import {
  Stack,
  FileText,
  FileCode,
  Terminal,
  Globe,
  SquaresFour,
  X,
  Crosshair,
  ArrowsOutCardinal,
  CornersOut,
  GridFour,
  Eye,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react'

export interface CateToolDisplay {
  Icon: PhosphorIcon
  /** Past-tense verb for a completed action ("Opened", "Ran", …). */
  verb: string
  /** Lowercase present-tense verb for an approval prompt ("open", "run", …). */
  request: string
  /** Short human label describing the target (path, command, url, panelId, …). */
  summary: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

const PANEL_ICONS: Record<string, PhosphorIcon> = {
  editor: FileCode,
  terminal: Terminal,
  browser: Globe,
  document: FileText,
}

/** Strip the `cate:` prefix from a synthetic tool name, if present. */
export function cateActionName(toolName: string): string {
  return toolName.startsWith('cate:') ? toolName.slice('cate:'.length) : toolName
}

export function cateToolDisplay(
  action: string,
  params: Record<string, unknown> = {},
): CateToolDisplay {
  const p = params ?? {}
  if (action === 'layout') {
    if (str(p.op) === 'arrange') {
      return { Icon: GridFour, verb: 'Arranged', request: 'arrange', summary: `panels · ${str(p.style) || str(p.layout) || 'tile'}` }
    }
    return { Icon: Stack, verb: 'Read', request: 'read', summary: 'canvas layout' }
  }
  if (action === 'browser') {
    return { Icon: Globe, verb: 'Navigated', request: 'navigate', summary: str(p.url) || str(p.panelId) || 'browser' }
  }
  if (action === 'terminal') {
    if (str(p.op) === 'read') {
      return { Icon: Terminal, verb: 'Read', request: 'read', summary: `terminal ${str(p.panelId)}`.trim() }
    }
    return { Icon: Terminal, verb: 'Ran', request: 'run', summary: str(p.command) || 'command' }
  }
  if (action === 'panel') {
    const target = (p.target ?? {}) as Record<string, unknown>
    switch (str(p.op)) {
      case 'open': {
        const type = str(p.type) || 'panel'
        const detail = str(target.path) || str(target.url) || str(target.command) || ''
        return { Icon: PANEL_ICONS[type] ?? SquaresFour, verb: 'Opened', request: 'open', summary: detail ? `${type} · ${detail}` : type }
      }
      case 'focus':
        return { Icon: Crosshair, verb: 'Focused', request: 'focus', summary: str(p.panelId) || 'panel' }
      case 'move':
        return { Icon: ArrowsOutCardinal, verb: 'Moved', request: 'move', summary: str(p.panelId) || 'panel' }
      case 'resize': {
        const size = str(p.preset) || (p.size && typeof p.size === 'object' ? 'custom' : '')
        const panelId = str(p.panelId) || 'panel'
        return { Icon: CornersOut, verb: 'Resized', request: 'resize', summary: size ? `${panelId} → ${size}` : panelId }
      }
      case 'close':
        return { Icon: X, verb: 'Closed', request: 'close', summary: str(p.panelId) || 'panel' }
      case 'preview':
        return {
          Icon: Eye,
          verb: p.preview === false ? 'Hid preview' : 'Previewed',
          request: p.preview === false ? 'hide preview for' : 'preview',
          summary: str(p.panelId) || 'panel',
        }
      default:
        return { Icon: SquaresFour, verb: 'Panel', request: 'manage', summary: str(p.op) || str(p.panelId) || 'panel' }
    }
  }
  return { Icon: SquaresFour, verb: 'Used', request: 'run', summary: action }
}
