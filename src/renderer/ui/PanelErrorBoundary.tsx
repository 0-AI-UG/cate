// =============================================================================
// PanelErrorBoundary
//
// Isolates a render error in a single panel so one broken panel (editor,
// browser, git, …) fails in place instead of tearing down the whole window via
// the single top-level boundary in main.tsx. Shows a compact inline fallback
// with a "Reload panel" action that resets the boundary and re-mounts the
// panel, and reports the error to Sentry with panel context.
// =============================================================================

import React from 'react'
import { ArrowClockwise, Warning } from '@phosphor-icons/react'
import log from '../lib/logger'
import { captureRendererException } from '../lib/sentry'

interface Props {
  children?: React.ReactNode
  /** Panel type — surfaced in the fallback copy and the Sentry context. */
  panelType?: string
  /** Panel id — used both for the Sentry context and to auto-reset the
   *  boundary when the same slot is reused for a different panel. */
  panelId?: string
}

interface State {
  error: Error | null
}

export class PanelErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: Props): void {
    // If the slot is reused for a different panel, drop the stale error so the
    // new panel gets a clean mount instead of inheriting the old fallback.
    if (this.state.error && prev.panelId !== this.props.panelId) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    log.error(
      'Panel render error (type=%s id=%s): %s\n%s',
      this.props.panelType ?? 'unknown',
      this.props.panelId ?? 'unknown',
      error.message,
      info.componentStack,
    )
    captureRendererException(error, {
      panelType: this.props.panelType,
      panelId: this.props.panelId,
      componentStack: info.componentStack,
      source: 'PanelErrorBoundary',
    })
  }

  private handleReload = (): void => {
    this.setState({ error: null })
  }

  render(): React.ReactNode {
    if (this.state.error) {
      const label = this.props.panelType ? `This ${this.props.panelType} panel` : 'This panel'
      return (
        <div className="w-full h-full flex flex-col items-center justify-center bg-surface-4 text-secondary p-4 text-center select-none">
          <Warning size={30} className="mb-2 text-muted" weight="duotone" />
          <p className="text-sm font-medium mb-1">{label} hit an error</p>
          <p className="text-xs text-muted max-w-[28ch] truncate" title={this.state.error.message}>
            {this.state.error.message}
          </p>
          <button
            onClick={this.handleReload}
            className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded bg-surface-6 hover:bg-hover text-primary transition-colors"
          >
            <ArrowClockwise size={13} />
            Reload panel
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
