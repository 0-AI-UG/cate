// =============================================================================
// Panel type definitions for the renderer
// =============================================================================

import type { PanelType } from '../../shared/types'
import { PANEL_DEFINITIONS } from '../../shared/panels'

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
}

// -----------------------------------------------------------------------------
// Panel display helpers
// -----------------------------------------------------------------------------

/** Returns a brand color hex string for the given panel type. */
export function panelColor(type: PanelType): string {
  return PANEL_DEFINITIONS[type].brandColor
}
