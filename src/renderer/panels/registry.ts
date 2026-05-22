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
  GitBranch,
  TreeStructure,
  SquaresFour,
  List,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react'
import type { PanelType, Point } from '../../shared/types'
import type { PanelPlacement } from '../stores/appStore'
import { useAppStore } from '../stores/appStore'
import { PANEL_DEFINITIONS, type SharedPanelDefinition } from '../../shared/panels'
import type { PanelProps } from './types'

// -----------------------------------------------------------------------------
// Lazy-loaded panel components. The `import(...)` expression on the right-hand
// side is what splits each panel into its own chunk, so this file is the only
// place that knows the per-type chunk boundary.
// -----------------------------------------------------------------------------

const TerminalPanel = React.lazy(() => import('./TerminalPanel'))
const EditorPanel = React.lazy(() => import('./EditorPanel'))
const BrowserPanel = React.lazy(() => import('./BrowserPanel'))
const GitPanel = React.lazy(() => import('./GitPanel'))
const FileExplorerPanel = React.lazy(() => import('./FileExplorerPanel'))
const ProjectListPanel = React.lazy(() => import('./ProjectListPanel'))
const CanvasPanel = React.lazy(() => import('./CanvasPanel'))

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
}

export interface RendererPanelDefinition extends SharedPanelDefinition {
  icon: PhosphorIcon
  /** React.lazy() wrapped panel component. Accepts the standard PanelProps
   *  plus optional per-type extras (filePath/url/zoomLevel) — the dispatcher
   *  reads those off the PanelState. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Component: LazyExoticComponent<ComponentType<any>>
  /** Spawn a fresh panel of this type into the workspace. Returns the new
   *  panelId or null if creation failed. */
  create: (args: PanelCreateArgs) => string | null
}

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

export const PANEL_REGISTRY: Record<PanelType, RendererPanelDefinition> = {
  terminal: {
    ...PANEL_DEFINITIONS.terminal,
    icon: Terminal,
    Component: TerminalPanel,
    create: ({ workspaceId, canvasPoint, placement, initialInput }) =>
      useAppStore.getState().createTerminal(workspaceId, initialInput, canvasPoint, placement) || null,
  },
  browser: {
    ...PANEL_DEFINITIONS.browser,
    icon: Globe,
    Component: BrowserPanel,
    create: ({ workspaceId, canvasPoint, placement, url }) =>
      useAppStore.getState().createBrowser(workspaceId, url, canvasPoint, placement) || null,
  },
  editor: {
    ...PANEL_DEFINITIONS.editor,
    icon: FileText,
    Component: EditorPanel,
    create: ({ workspaceId, canvasPoint, placement, filePath }) =>
      useAppStore.getState().createEditor(workspaceId, filePath, canvasPoint, placement) || null,
  },
  git: {
    ...PANEL_DEFINITIONS.git,
    icon: GitBranch,
    Component: GitPanel,
    create: ({ workspaceId, canvasPoint, placement }) =>
      useAppStore.getState().createGit(workspaceId, canvasPoint, placement) || null,
  },
  fileExplorer: {
    ...PANEL_DEFINITIONS.fileExplorer,
    icon: TreeStructure,
    Component: FileExplorerPanel,
    create: ({ workspaceId, canvasPoint, placement }) =>
      useAppStore.getState().createFileExplorer(workspaceId, canvasPoint, placement) || null,
  },
  projectList: {
    ...PANEL_DEFINITIONS.projectList,
    icon: List,
    Component: ProjectListPanel,
    create: ({ workspaceId, canvasPoint, placement }) =>
      useAppStore.getState().createProjectList(workspaceId, canvasPoint, placement) || null,
  },
  canvas: {
    ...PANEL_DEFINITIONS.canvas,
    icon: SquaresFour,
    Component: CanvasPanel,
    create: ({ workspaceId, canvasPoint, placement }) =>
      useAppStore.getState().createCanvas(workspaceId, canvasPoint, placement) || null,
  },
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
  panel: { type: PanelType; id: string; filePath?: string; url?: string },
  ctx: { workspaceId: string; nodeId: string; zoomLevel?: number },
): React.ReactElement | null {
  const def = PANEL_REGISTRY[panel.type]
  if (!def) return null
  const { Component } = def
  // Per-type extras are passed through; components that don't accept them
  // simply ignore the extra props.
  const extras: Record<string, unknown> = {}
  if (panel.type === 'editor') extras.filePath = panel.filePath
  if (panel.type === 'browser') {
    extras.url = panel.url
    extras.zoomLevel = ctx.zoomLevel ?? 1
  }
  const props: PanelProps & Record<string, unknown> = {
    panelId: panel.id,
    workspaceId: ctx.workspaceId,
    nodeId: ctx.nodeId,
    ...extras,
  }
  return React.createElement(Component, props)
}
