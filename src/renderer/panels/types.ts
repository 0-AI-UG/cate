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
  url?: string
  /** Per-panel proxy URL (issue #241). When set, the panel runs in its own
   *  proxy-derived session instead of the shared browser session. */
  proxyUrl?: string
  /** Persisted open tabs (light model) + the active tab id. */
  tabs?: BrowserTab[]
  activeTabId?: string
}
