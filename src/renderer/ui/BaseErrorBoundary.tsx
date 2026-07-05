// =============================================================================
// BaseErrorBoundary
//
// Shared skeleton for the renderer's per-slot error boundaries (NodeErrorBoundary,
// PanelErrorBoundary): the getDerivedStateFromError → state, the reset-on-
// resetKey-change in componentDidUpdate (so a reused slot gets a clean mount),
// and the componentDidCatch → log + captureRendererException wiring. Each
// concrete boundary supplies only what actually differs: the reset key, the
// fallback UI, its own log line, and the Sentry context/source.
// =============================================================================

import React from 'react'
import { captureRendererException } from '../lib/sentry'

interface Props {
  children?: React.ReactNode
  /** When this changes while an error is shown, the boundary resets — so a slot
   *  reused for a different node/panel mounts clean instead of inheriting the
   *  stale fallback. */
  resetKey?: string
  /** Rendered in place of the children when a descendant render throws. Receives
   *  a `reset` to clear the error and re-mount (e.g. a "Reload" button). */
  fallback: (error: Error, reset: () => void) => React.ReactNode
  /** Boundary-specific logging (each formats its own message). */
  logError: (error: Error, info: React.ErrorInfo) => void
  /** Extra Sentry context merged into the captured exception. */
  sentryContext: Record<string, unknown>
  /** Sentry `source` tag identifying which boundary caught the error. */
  sentrySource: string
}

interface State {
  error: Error | null
}

export class BaseErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.logError(error, info)
    captureRendererException(error, {
      ...this.props.sentryContext,
      componentStack: info.componentStack,
      source: this.props.sentrySource,
    })
  }

  private reset = (): void => {
    this.setState({ error: null })
  }

  render(): React.ReactNode {
    if (this.state.error) return this.props.fallback(this.state.error, this.reset)
    return this.props.children
  }
}
