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
  /** When true, a canvas node hosting this panel is exempt from viewport
   *  culling — it stays mounted even when scrolled off-screen. Set for panels
   *  whose live state lives in an isolated `<webview>` guest process and cannot
   *  be reconstructed on remount (extensions hold session state in-page).
   *  Terminals/editors leave this false: their backing state is in the main
   *  process (PTY) or trivially rehydrated (Monaco), so culling them is safe. */
  keepMountedOffscreen: boolean
  /** When true, an inactive tab of this type stays mounted (hidden) in its dock
   *  stack instead of being unmounted, so its live `<webview>` guest process
   *  survives a tab switch. Without this, switching away from a browser/extension
   *  tab and back reloads the page and loses all in-page state (#459).
   *  Terminals/editors leave this false: unmounting an inactive terminal frees
   *  its xterm/WebGL context (the PTY keeps running in main), which is the
   *  cheaper trade-off. */
  keepMountedWhenTabHidden: boolean
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
    mutedColor: '#4a9960',
    tintClass: 'text-emerald-400',
    defaultSize: { width: 640, height: 400 },
    minimumSize: { width: 320, height: 200 },
    ghostSvg: ghost('rgb(77,217,100)', '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
    canLiveOnCanvas: true,
    keepMountedOffscreen: false,
    keepMountedWhenTabHidden: false,
  },
  browser: {
    type: 'browser',
    label: 'Browser',
    brandColor: '#4A9EFF',
    mutedColor: '#4a7ab0',
    tintClass: 'text-sky-400',
    defaultSize: { width: 800, height: 600 },
    minimumSize: { width: 400, height: 300 },
    ghostSvg: ghost('rgb(74,158,255)', '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
    canLiveOnCanvas: true,
    // Browser automation must remain usable when an API caller creates the
    // panel in the background without moving the user's camera.
    keepMountedOffscreen: true,
    keepMountedWhenTabHidden: true,
  },
  editor: {
    type: 'editor',
    label: 'Editor',
    brandColor: '#FF9F0A',
    mutedColor: '#b07440',
    tintClass: 'text-orange-400',
    defaultSize: { width: 600, height: 500 },
    minimumSize: { width: 300, height: 250 },
    ghostSvg: ghost('rgb(255,159,10)', '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
    canLiveOnCanvas: true,
    keepMountedOffscreen: false,
    keepMountedWhenTabHidden: false,
  },
  agent: {
    type: 'agent',
    label: 'Agent',
    brandColor: '#4A9EFF',
    mutedColor: '#3a7acc',
    tintClass: 'text-blue-400',
    defaultSize: { width: 760, height: 480 },
    minimumSize: { width: 360, height: 320 },
    ghostSvg: ghost('rgb(74,158,255)', '<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z"/><path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z"/>'),
    canLiveOnCanvas: true,
    keepMountedOffscreen: false,
    keepMountedWhenTabHidden: false,
  },
  document: {
    type: 'document',
    label: 'Document',
    brandColor: '#AF52DE',
    mutedColor: '#7a4a9a',
    tintClass: 'text-purple-400',
    defaultSize: { width: 700, height: 500 },
    minimumSize: { width: 300, height: 250 },
    ghostSvg: ghost('rgb(175,82,222)', '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><circle cx="12" cy="15" r="3"/>'),
    canLiveOnCanvas: true,
    keepMountedOffscreen: false,
    keepMountedWhenTabHidden: false,
  },
  canvas: {
    type: 'canvas',
    label: 'Canvas',
    brandColor: '#BF5AF2',
    mutedColor: '#7a4a9a',
    tintClass: 'text-violet-400',
    defaultSize: { width: 800, height: 600 },
    minimumSize: { width: 400, height: 300 },
    ghostSvg: ghost('rgb(191,90,242)', '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>'),
    canLiveOnCanvas: false,
    keepMountedOffscreen: false,
    keepMountedWhenTabHidden: false,
  },
  extension: {
    type: 'extension',
    label: 'Extension',
    brandColor: '#8E8E93',
    mutedColor: '#6a6a6e',
    tintClass: 'text-zinc-400',
    defaultSize: { width: 600, height: 400 },
    minimumSize: { width: 320, height: 200 },
    ghostSvg: ghost('rgb(142,142,147)', '<path d="M16 4h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2 2 2 0 0 0 0 4 2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2 2 2 0 0 0-4 0 2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2 2 2 0 0 0 0-4 2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 0 4 0 2 2 0 0 1 2-2z"/>'),
    canLiveOnCanvas: true,
    keepMountedOffscreen: true,
    keepMountedWhenTabHidden: true,
  },
}

/** Lookup helper. Falls back to the editor definition (matches the previous
 *  drag-ghost behaviour). */
export function getSharedPanelDef(type: PanelType | string): SharedPanelDefinition {
  return PANEL_DEFINITIONS[type as PanelType] ?? PANEL_DEFINITIONS.editor
}

/** True when a canvas node hosting this panel type must stay mounted even when
 *  scrolled off-screen (its live `<webview>` state can't survive a remount).
 *
 *  Per-TYPE answer only. Extension panels are refined per INSTANCE in
 *  `renderer/panels/keepMountedPanels.ts`: url-mode extensions (remote SaaS
 *  pages) are cullable because their session lives in a persistent partition. */
export function keepsMountedOffscreen(type: PanelType | string | undefined): boolean {
  return !!type && getSharedPanelDef(type).keepMountedOffscreen
}

/** True when an inactive tab of this type must stay mounted (hidden) in its dock
 *  stack rather than being unmounted — its live `<webview>` state can't survive a
 *  remount, so unmounting on tab switch would reload the page (#459). */
export function keepsMountedWhenTabHidden(type: PanelType | string | undefined): boolean {
  return !!type && getSharedPanelDef(type).keepMountedWhenTabHidden
}

// -----------------------------------------------------------------------------
// Workspace trust — process-bearing panel types
// -----------------------------------------------------------------------------

/**
 * Panel types that start something on mount: a PTY, an agent (pi) session, a
 * `<webview>` that loads a URL, or an extension server. Mounting one of these
 * from a layout file the USER did not author is the trust boundary crossed by
 * GHSA-8769-jp52-985f: `.cate/workspace.json` is deliberately shareable (see
 * `main/cateGitignore.ts`), so a cloned repo could ship an `agent` panel that
 * auto-started pi — and with it the project's MCP servers — on open.
 *
 * `editor`, `canvas` and `document` are passive: they render workspace-local
 * content and spawn nothing, so they restore from any layout file.
 *
 * Keep this a per-TYPE answer with no exceptions. Refining it per instance
 * ("this browser tab is only a localhost URL") re-introduces exactly the
 * attacker-controlled reasoning the boundary exists to avoid.
 */
export const PROCESS_BEARING_PANEL_TYPES: readonly PanelType[] = [
  'terminal',
  'browser',
  'agent',
  'extension',
]

/** True when restoring a panel of this type starts a process, loads a URL, or
 *  otherwise acts on its own. Such panels are withheld from an untrusted
 *  project's layout until the user explicitly trusts it. */
export function isProcessBearingPanelType(type: PanelType | string | undefined): boolean {
  return !!type && (PROCESS_BEARING_PANEL_TYPES as readonly string[]).includes(type)
}

// -----------------------------------------------------------------------------
// Default panel size resolution
// -----------------------------------------------------------------------------

/** The fixed default size for a panel type. Panel size is no longer user-configurable. */
export function resolvePanelSize(type: PanelType, _settings?: unknown): Size {
  return PANEL_DEFINITIONS[type].defaultSize
}
