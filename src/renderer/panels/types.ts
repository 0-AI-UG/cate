// =============================================================================
// Panel type definitions for the renderer
// =============================================================================

import type { BrowserTab } from '../../shared/types'

// -----------------------------------------------------------------------------
// Base panel props
// -----------------------------------------------------------------------------

export interface PanelProps {
  panelId: string
  workspaceId: string
  nodeId?: string
}

// -----------------------------------------------------------------------------
// Panel-specific props
// -----------------------------------------------------------------------------

export interface TerminalPanelProps extends PanelProps {
  initialInput?: string
}

export interface EditorPanelProps extends PanelProps {
  filePath?: string
}

export interface BrowserPanelProps extends PanelProps {
  /** Per-panel proxy URL (issue #241). When set, the panel runs in its own
   *  proxy-derived session instead of the shared browser session. */
  proxyUrl?: string
  /** Canonical persisted navigation state. */
  tabs: BrowserTab[]
  activeTabId: string
}

export interface ExtensionPanelProps extends PanelProps {
  /** Manifest id of the extension hosting this panel. */
  extensionId?: string
  /** Panel id WITHIN the extension's manifest (one extension can declare many). */
  extensionPanelId?: string
}
