// =============================================================================
// Panel type definitions for the renderer
// =============================================================================

import type { PanelType } from '../../shared/types'

// -----------------------------------------------------------------------------
// Base panel props
// -----------------------------------------------------------------------------

export interface PanelProps {
  panelId: string
  workspaceId: string
  nodeId: string
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

/** Returns a Lucide icon name for the given panel type. */
export function panelIcon(type: PanelType): string {
  switch (type) {
    case 'terminal':
      return 'Terminal'
    case 'browser':
      return 'Globe'
    case 'editor':
      return 'FileText'
  }
}

/** Returns a brand color hex string for the given panel type. */
export function panelColor(type: PanelType): string {
  switch (type) {
    case 'terminal':
      return '#4DD964' // green
    case 'browser':
      return '#4A9EFF' // blue
    case 'editor':
      return '#FF9F0A' // orange
  }
}
