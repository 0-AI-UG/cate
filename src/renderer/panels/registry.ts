// =============================================================================
// Panel registry (renderer side)
//
// Extends the shared per-type data in `src/shared/panels.ts` with renderer-only
// concerns: the Phosphor icon component, the lazy panel component, and a
// factory that maps to the right `appStore.createXxx()` call.
//
// Every place that used to switch on `panel.type` should read from
// PANEL_REGISTRY here instead. Adding a new panel type is a two-touch change:
//   1. add a SharedPanelDefinition in src/shared/panels.ts
//   2. add a RendererPanelDefinition entry here
// Nothing else in the renderer or main process needs to know about it.
// =============================================================================

import React, { type LazyExoticComponent, type ComponentType } from 'react'
import {
  Terminal,
  Globe,
  FileText,
  SquaresFour,
  FileDoc,
  PuzzlePiece,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react'
import type { PanelType, Point, PanelState } from '../../shared/types'
import type { PanelPlacement } from '../stores/appStore'
import { useAppStore } from '../stores/appStore'
import { PANEL_DEFINITIONS, type SharedPanelDefinition } from '../../shared/panels'
import { CateLogo } from '../ui/CateLogo'
import { PanelErrorBoundary } from '../ui/PanelErrorBoundary'
import type { PanelProps } from './types'

// -----------------------------------------------------------------------------
// Lazy-loaded panel components. The `import(...)` expression on the right-hand
// side is what splits each panel into its own chunk, so this file is the only
// place that knows the per-type chunk boundary.
// -----------------------------------------------------------------------------

const TerminalPanel = React.lazy(() => import('./TerminalPanel'))
const EditorPanel = React.lazy(() => import('./EditorPanel'))
const BrowserPanel = React.lazy(() => import('./BrowserPanel'))
const CanvasPanel = React.lazy(() => import('./CanvasPanel'))
const CateAgentPanel = React.lazy(() => import('../../cateAgent/renderer/CateAgentPanel'))
const DocumentPanel = React.lazy(() => import('./DocumentPanel'))
const ExtensionPanel = React.lazy(() => import('./ExtensionPanel'))

// -----------------------------------------------------------------------------
// Renderer definition
// -----------------------------------------------------------------------------

/** Arguments accepted by panel factories. Each factory ignores fields it
 *  doesn't understand — e.g. the git factory ignores `filePath`. */
export interface PanelCreateArgs {
  workspaceId: string
  canvasPoint?: Point
  placement?: PanelPlacement
  /** Editor only. */
  filePath?: string
  /** Browser only. */
  url?: string
  /** Terminal only. */
  initialInput?: string
  /** Document only. */
  documentType?: 'pdf' | 'docx' | 'image'
  /** Extension only. */
  extensionId?: string
  /** Extension only — panel id within the extension's manifest. */
  extensionPanelId?: string
}

export interface RendererPanelDefinition extends SharedPanelDefinition {
  icon: PhosphorIcon | ComponentType<{ size?: number; className?: string }>
  /** React.lazy() wrapped panel component. Accepts the standard PanelProps
   *  plus optional per-type extras (filePath/url/zoomLevel) — the dispatcher
   *  reads those off the PanelState. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Component: LazyExoticComponent<ComponentType<any>>
  /** Spawn a fresh panel of this type into the workspace. Returns the new
   *  panelId or null if creation failed. */
  create: (args: PanelCreateArgs) => string | null
  props: (panel: PanelState, ctx: PanelRenderContext) => Record<string, unknown>
}

export interface PanelRenderContext {
  workspaceId: string
  nodeId: string
  zoomLevel?: number
  renderPanelContent?: (panelId: string, nodeId: string, zoomLevel: number) => React.ReactNode
}

const baseProps = (panel: PanelState, ctx: PanelRenderContext): Record<string, unknown> => ({
  panelId: panel.id,
  workspaceId: ctx.workspaceId,
  nodeId: ctx.nodeId,
})

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

export const PANEL_REGISTRY: Record<PanelType, RendererPanelDefinition> = {
  terminal: {
    ...PANEL_DEFINITIONS.terminal,
    icon: Terminal,
    Component: TerminalPanel,
    create: ({ workspaceId, canvasPoint, placement, initialInput }) =>
      trackCreated('terminal', useAppStore.getState().createTerminal(workspaceId, initialInput, canvasPoint, placement) || null),
    props: baseProps,
  },
  browser: {
    ...PANEL_DEFINITIONS.browser,
    icon: Globe,
    Component: BrowserPanel,
    create: ({ workspaceId, canvasPoint, placement, url }) =>
      trackCreated('browser', useAppStore.getState().createBrowser(workspaceId, url, canvasPoint, placement) || null),
    props: (panel, ctx) => ({
      ...baseProps(panel, ctx),
      proxyUrl: panel.proxyUrl,
      tabs: panel.tabs,
      activeTabId: panel.activeTabId,
      zoomLevel: ctx.zoomLevel ?? 1,
    }),
  },
  editor: {
    ...PANEL_DEFINITIONS.editor,
    icon: FileText,
    Component: EditorPanel,
    create: ({ workspaceId, canvasPoint, placement, filePath }) =>
      trackCreated('editor', useAppStore.getState().createEditor(workspaceId, filePath, canvasPoint, placement) || null),
    props: (panel, ctx) => ({ ...baseProps(panel, ctx), filePath: panel.filePath }),
  },
  canvas: {
    ...PANEL_DEFINITIONS.canvas,
    icon: SquaresFour,
    Component: CanvasPanel,
    create: ({ workspaceId, canvasPoint, placement }) =>
      trackCreated('canvas', useAppStore.getState().createCanvas(workspaceId, canvasPoint, placement) || null),
    props: (panel, ctx) => ({ ...baseProps(panel, ctx), renderPanelContent: ctx.renderPanelContent }),
  },
  cateAgent: {
    ...PANEL_DEFINITIONS.cateAgent,
    icon: CateLogo,
    Component: CateAgentPanel,
    create: ({ workspaceId, canvasPoint, placement }) =>
      trackCreated('cateAgent', useAppStore.getState().createCateAgent(workspaceId, canvasPoint, placement) || null),
    props: baseProps,
  },
  document: {
    ...PANEL_DEFINITIONS.document,
    icon: FileDoc,
    Component: DocumentPanel,
    create: ({ workspaceId, canvasPoint, placement, filePath, documentType }) =>
      trackCreated('document', useAppStore.getState().createDocument(workspaceId, filePath, documentType, canvasPoint, placement) || null),
    props: (panel, ctx) => ({ ...baseProps(panel, ctx), filePath: panel.filePath }),
  },
  extension: {
    ...PANEL_DEFINITIONS.extension,
    icon: PuzzlePiece,
    Component: ExtensionPanel,
    create: ({ workspaceId, canvasPoint, placement, extensionId, extensionPanelId }) =>
      extensionId && extensionPanelId
        ? trackCreated('extension', useAppStore.getState().createExtensionPanel(workspaceId, extensionId, extensionPanelId, canvasPoint, placement) || null)
        : null,
    props: (panel, ctx) => ({
      ...baseProps(panel, ctx),
      extensionId: panel.extensionId,
      extensionPanelId: panel.extensionPanelId,
    }),
  },
}

/** Wrap a create() result with an anonymous usage signal. Lives on the registry
 *  path (command palette, toolbar, welcome screen) — the user-initiated creation
 *  surface — so session restore (which calls appStore.createX directly) does not
 *  inflate the counts. No-ops when the panel wasn't created. */
function trackCreated(type: PanelType, id: string | null): string | null {
  if (id) {
    try { window.electronAPI?.trackFeatureUsed?.('panel_created', { type }) } catch { /* noop */ }
  }
  return id
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Lookup the renderer definition for a panel type. Falls back to the editor
 *  definition for unknown values so the UI degrades to a sensible default
 *  rather than blowing up. */
export function getPanelDef(type: PanelType | string): RendererPanelDefinition {
  return PANEL_REGISTRY[type as PanelType] ?? PANEL_REGISTRY.editor
}

/** Render the component for a panel. Reads the panel's per-type extras off
 *  the panel state itself, so callers don't need to know which extras any
 *  given type expects. Caller wraps in <Suspense> at the boundary it wants. */
export function renderPanelComponent(
  panel: PanelState,
  ctx: PanelRenderContext,
): React.ReactElement | null {
  const def = PANEL_REGISTRY[panel.type]
  if (!def) return null
  const { Component } = def
  const props = def.props(panel, ctx) as PanelProps & Record<string, unknown>
  // Wrap every panel in its own error boundary so a render error in one panel
  // fails in place rather than collapsing the whole window through the single
  // top-level boundary. Keyed by panel id so a reused slot resets cleanly.
  return React.createElement(
    PanelErrorBoundary,
    { panelType: panel.type, panelId: panel.id },
    React.createElement(Component, { ...props, key: panel.id }),
  )
}
