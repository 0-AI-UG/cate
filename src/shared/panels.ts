// =============================================================================
// Panel definitions — per-type data shared between main and renderer.
//
// This module holds everything that:
//   1. doesn't depend on React, Phosphor, or other renderer-only libraries, AND
//   2. is needed in more than one place (drag ghost in main, sizes everywhere,
//      labels/colors in many renderer files).
//
// Renderer-only fields (icon component, lazy component, factory) live in
// `src/renderer/panels/registry.ts`, which extends this with the renderer
// concerns and re-exports the unified definition.
//
// Adding a new panel type means adding one entry here + one entry in
// `registry.ts`. The PanelType union in `./types.ts` keeps everyone honest.
// =============================================================================

import type { PanelType, Size } from './types'

// -----------------------------------------------------------------------------
// Definition shape
// -----------------------------------------------------------------------------

export interface SharedPanelDefinition {
  type: PanelType
  /** Human-readable label, e.g. "File Explorer". Used in tooltips, split menus,
   *  fallback titles. */
  label: string
  /** Brand color used in panel chrome and the drag ghost window. */
  brandColor: string
  /** More saturated variant used in the full-screen panel switcher overlay. */
  switcherColor: string
  /** Dim variant used in the minimap dot. */
  mutedColor: string
  /** Tailwind class for tab-bar tint when the tab is active. */
  tintClass: string
  defaultSize: Size
  minimumSize: Size
  /** Inline SVG (12×12) used by the drag-ghost window rendered in the main
   *  process. Lives here so main and renderer agree on the same icon set. */
  ghostSvg: string
  /** Whether a panel of this type can be placed as a canvas node. Canvas
   *  panels themselves live only in dock zones. */
  canLiveOnCanvas: boolean
}

// -----------------------------------------------------------------------------
// Ghost SVG helpers — keep stroke colors in one place so the brand color
// drives the ghost icon automatically.
// -----------------------------------------------------------------------------

function ghost(stroke: string, body: string): string {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

// -----------------------------------------------------------------------------
// Definitions
// -----------------------------------------------------------------------------

export const PANEL_DEFINITIONS: Record<PanelType, SharedPanelDefinition> = {
  terminal: {
    type: 'terminal',
    label: 'Terminal',
    brandColor: '#4DD964',
    switcherColor: '#34C759',
    mutedColor: '#4a9960',
    tintClass: 'text-emerald-400',
    defaultSize: { width: 640, height: 400 },
    minimumSize: { width: 320, height: 200 },
    ghostSvg: ghost('rgb(77,217,100)', '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
    canLiveOnCanvas: true,
  },
  browser: {
    type: 'browser',
    label: 'Browser',
    brandColor: '#4A9EFF',
    switcherColor: '#007AFF',
    mutedColor: '#4a7ab0',
    tintClass: 'text-sky-400',
    defaultSize: { width: 800, height: 600 },
    minimumSize: { width: 400, height: 300 },
    ghostSvg: ghost('rgb(74,158,255)', '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
    canLiveOnCanvas: true,
  },
  editor: {
    type: 'editor',
    label: 'Editor',
    brandColor: '#FF9F0A',
    switcherColor: '#FF9500',
    mutedColor: '#b07440',
    tintClass: 'text-orange-400',
    defaultSize: { width: 600, height: 500 },
    minimumSize: { width: 300, height: 250 },
    ghostSvg: ghost('rgb(255,159,10)', '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
    canLiveOnCanvas: true,
  },
  git: {
    type: 'git',
    label: 'Git',
    brandColor: '#FF3B30',
    switcherColor: '#FF3B30',
    mutedColor: '#8a3a35',
    tintClass: 'text-red-400',
    defaultSize: { width: 500, height: 600 },
    minimumSize: { width: 350, height: 300 },
    ghostSvg: ghost('rgb(255,59,48)', '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
    canLiveOnCanvas: true,
  },
  fileExplorer: {
    type: 'fileExplorer',
    label: 'File Explorer',
    brandColor: '#5AC8FA',
    switcherColor: '#5AC8FA',
    mutedColor: '#4a8aa5',
    tintClass: 'text-cyan-400',
    defaultSize: { width: 300, height: 500 },
    minimumSize: { width: 180, height: 200 },
    ghostSvg: ghost('rgb(90,200,250)', '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
    canLiveOnCanvas: true,
  },
  projectList: {
    type: 'projectList',
    label: 'Projects',
    brandColor: '#FFD60A',
    switcherColor: '#FFD60A',
    mutedColor: '#a89030',
    tintClass: 'text-yellow-400',
    defaultSize: { width: 300, height: 400 },
    minimumSize: { width: 180, height: 200 },
    ghostSvg: ghost('rgb(255,214,10)', '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>'),
    canLiveOnCanvas: true,
  },
  canvas: {
    type: 'canvas',
    label: 'Canvas',
    brandColor: '#BF5AF2',
    switcherColor: '#BF5AF2',
    mutedColor: '#7a4a9a',
    tintClass: 'text-violet-400',
    defaultSize: { width: 800, height: 600 },
    minimumSize: { width: 400, height: 300 },
    ghostSvg: ghost('rgb(191,90,242)', '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>'),
    canLiveOnCanvas: false,
  },
}

/** Ordered list of every known panel type. */
export const PANEL_TYPES: PanelType[] = Object.keys(PANEL_DEFINITIONS) as PanelType[]

/** Lookup helper. Falls back to the editor definition (matches the previous
 *  drag-ghost behaviour). */
export function getSharedPanelDef(type: PanelType | string): SharedPanelDefinition {
  return PANEL_DEFINITIONS[type as PanelType] ?? PANEL_DEFINITIONS.editor
}
