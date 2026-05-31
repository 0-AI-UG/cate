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
  GitBranch,
  TreeStructure,
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
  git: GitBranch,
  fileExplorer: TreeStructure,
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
  const target = (p.target ?? {}) as Record<string, unknown>
  switch (action) {
    case 'get_layout':
      return { Icon: Stack, verb: 'Read', request: 'read', summary: 'canvas layout' }
    case 'open_panel': {
      const type = str(p.type) || 'panel'
      const detail = str(target.path) || str(target.url) || str(target.command) || ''
      return {
        Icon: PANEL_ICONS[type] ?? SquaresFour,
        verb: 'Opened',
        request: 'open',
        summary: detail ? `${type} · ${detail}` : type,
      }
    }
    case 'close_panel':
      return { Icon: X, verb: 'Closed', request: 'close', summary: str(p.panelId) || 'panel' }
    case 'focus_panel':
      return { Icon: Crosshair, verb: 'Focused', request: 'focus', summary: str(p.panelId) || 'panel' }
    case 'move_panel':
      return { Icon: ArrowsOutCardinal, verb: 'Moved', request: 'move', summary: str(p.panelId) || 'panel' }
    case 'resize_panel': {
      const size = str(p.preset) || (p.size && typeof p.size === 'object' ? 'custom' : '')
      const panelId = str(p.panelId) || 'panel'
      return { Icon: CornersOut, verb: 'Resized', request: 'resize', summary: size ? `${panelId} → ${size}` : panelId }
    }
    case 'arrange':
      return { Icon: GridFour, verb: 'Arranged', request: 'arrange', summary: `panels · ${str(p.layout) || 'tile'}` }
    case 'run_in_terminal':
      return { Icon: Terminal, verb: 'Ran', request: 'run', summary: str(p.command) || 'command' }
    case 'read_terminal':
      return { Icon: Terminal, verb: 'Read', request: 'read', summary: `terminal ${str(p.panelId)}`.trim() }
    case 'open_url':
      return { Icon: Globe, verb: 'Opened URL', request: 'open', summary: str(p.url) || 'url' }
    case 'set_markdown_preview':
      return {
        Icon: Eye,
        verb: p.preview === false ? 'Hid preview' : 'Previewed',
        request: p.preview === false ? 'hide preview for' : 'preview',
        summary: str(p.panelId) || 'panel',
      }
    default:
      return { Icon: SquaresFour, verb: 'Used', request: 'run', summary: action }
  }
}
