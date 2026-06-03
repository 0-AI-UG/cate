// =============================================================================
// Panel type definitions for the renderer
// =============================================================================

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
