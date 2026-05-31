// =============================================================================
// Presentation mapping for cate-control tool calls - turns an (action, params)
// pair into an icon + human-readable verb + short summary. Shared by the
// in-thread CateToolCard so the agent panel renders Cate's canvas actions as
// compact custom cards instead of raw JSON.
// The agent addresses panels by title, so values are already human-readable.
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
  ArrowsOutCardinal,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react'

export interface CateToolDisplay {
  Icon: PhosphorIcon
  /** Past-tense verb for a completed action ("Opened", "Ran", …). */
  verb: string
  /** Lowercase present-tense verb for an approval prompt ("open", "run", …). */
  request: string
  /** Short human label describing the target (title, path, command, url, …). */
  summary: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** A readable label/value row for the expanded tool-call body. */
export interface CateField {
  label: string
  value: string
}

/** Turn a control request's params into human-readable rows for the expanded
 *  card body - a structured view of what Cate was asked to do, instead of a raw
 *  JSON dump. Pure; only the meaningful params for the action/op are surfaced. */
export function cateToolFields(
  action: string,
  params: Record<string, unknown> = {},
): CateField[] {
  const p = params ?? {}
  const fields: CateField[] = []
  const add = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return
    fields.push({ label, value: String(value) })
  }
  const target = (p.target ?? {}) as Record<string, unknown>
  const placement = (p.placement ?? {}) as Record<string, unknown>
  const placementText = (): string => {
    const rel = str(placement.relativeTo)
    const pos = str(placement.position)
    if (pos && rel) return `${pos} of ${rel}`
    if (pos) return pos
    if (rel) return `near ${rel}`
    return ''
  }

  switch (action) {
    case 'panel': {
      const op = str(p.op)
      add('panel', p.panel)
      if (op === 'open') {
        add('type', p.type)
        add('path', target.path)
        if (typeof target.line === 'number') add('line', target.line)
        add('url', target.url)
        add('command', target.command)
        add('cwd', target.cwd)
        if (target.preview === true) add('preview', 'on')
      }
      add('placement', placementText())
      break
    }
    case 'browser':
      add('panel', p.panel)
      add('url', p.url)
      add('selector', p.selector)
      add('js', p.js)
      break
    case 'terminal': {
      const op = str(p.op)
      add('panel', p.panel)
      if (op === 'run') {
        add('command', p.command)
        if (p.newPanel === true) add('new panel', 'yes')
      }
      if (op === 'read' && typeof p.lines === 'number') add('lines', p.lines)
      break
    }
    // layout (read) has no input params to surface.
  }
  return fields
}

const PANEL_ICONS: Record<string, PhosphorIcon> = {
  editor: FileCode,
  terminal: Terminal,
  browser: Globe,
  document: FileText,
}

/** True for a cate-control tool call, in either form: the live round-trip's
 *  synthetic `cate:<action>` name, or pi's raw `cate_<action>` name as persisted
 *  in the session file (replayed verbatim on resume, like `plan_complete`). */
export function isCateTool(toolName: string): boolean {
  return toolName.startsWith('cate:') || toolName.startsWith('cate_')
}

/** Strip the `cate:` / `cate_` prefix to the bare action (e.g. "browser"). */
export function cateActionName(toolName: string): string {
  return isCateTool(toolName) ? toolName.slice('cate:'.length) : toolName
}

export function cateToolDisplay(
  action: string,
  params: Record<string, unknown> = {},
): CateToolDisplay {
  const p = params ?? {}
  const panel = (): string => str(p.panel) || 'panel'
  if (action === 'layout') {
    return { Icon: Stack, verb: 'Read', request: 'read', summary: 'canvas layout' }
  }
  if (action === 'browser') {
    // Tolerate a bare {url} (no op) as a navigate, for back-compat.
    const op = str(p.op) || (str(p.url) ? 'navigate' : '')
    switch (op) {
      case 'navigate': return { Icon: Globe, verb: 'Navigated', request: 'navigate', summary: str(p.url) || panel() }
      case 'back': return { Icon: Globe, verb: 'Went back', request: 'go back', summary: panel() }
      case 'forward': return { Icon: Globe, verb: 'Went forward', request: 'go forward', summary: panel() }
      case 'reload': return { Icon: Globe, verb: 'Reloaded', request: 'reload', summary: panel() }
      case 'stop': return { Icon: Globe, verb: 'Stopped', request: 'stop', summary: panel() }
      case 'info': return { Icon: Globe, verb: 'Read', request: 'read', summary: panel() }
      case 'read': return { Icon: Globe, verb: 'Read', request: 'read', summary: str(p.selector) || panel() }
      case 'eval': return { Icon: Globe, verb: 'Evaluated', request: 'evaluate', summary: str(p.js) || panel() }
      case 'screenshot': return { Icon: Globe, verb: 'Captured', request: 'screenshot', summary: panel() }
      default: return { Icon: Globe, verb: 'Browser', request: 'control', summary: panel() }
    }
  }
  if (action === 'terminal') {
    if (str(p.op) === 'read') {
      return { Icon: Terminal, verb: 'Read', request: 'read', summary: panel() }
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
      case 'close':
        return { Icon: X, verb: 'Closed', request: 'close', summary: panel() }
      case 'move':
        return { Icon: ArrowsOutCardinal, verb: 'Moved', request: 'move', summary: panel() }
      default:
        return { Icon: SquaresFour, verb: 'Panel', request: 'manage', summary: str(p.op) || panel() }
    }
  }
  return { Icon: SquaresFour, verb: 'Used', request: 'run', summary: action }
}
