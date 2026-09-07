// =============================================================================
// Panel type definitions for the renderer
// =============================================================================

import type { BrowserTab } from '../../shared/types'
import type { CodingAgentLaunch } from '../../shared/codingAgentRuns'

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
  codingAgentLaunch?: CodingAgentLaunch
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

export type AgentPanelProps = PanelProps
export interface NativeAppPanelProps extends PanelProps {
  /** macOS bundle id to capture (e.g. "com.apple.Safari"). Unset until the
   *  user picks an app from the panel's launcher. */
  nativeAppBundleId?: string
}
