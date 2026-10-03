// Shared skeleton for per-slot error boundaries: getDerivedStateFromError ->
// state, reset when `resetKey` changes (so a reused slot mounts clean), and
// componentDidCatch -> log + the installed error reporter. Each concrete
// boundary supplies the reset key, the fallback, its log line and the report
// context.

import React from 'react'

export type ErrorReporter = (error: Error, context: Record<string, unknown>) => void

let reporter: ErrorReporter | undefined

/** The shell's crash reporting (Sentry on desktop). */
export function installErrorReporter(next: ErrorReporter | undefined): void {
  reporter = next
}

interface Props {
  children?: React.ReactNode
  /** When this changes while an error is shown, the boundary resets, so a slot
   *  reused for a different node or panel mounts clean instead of inheriting
   *  the stale fallback. */
  resetKey?: string
  /** Rendered in place of the children when a descendant render throws.
   *  `reset` clears the error and re-mounts. */
  fallback: (error: Error, reset: () => void) => React.ReactNode
  logError: (error: Error, info: React.ErrorInfo) => void
  /** Extra context merged into the reported exception. */
  reportContext: Record<string, unknown>
  /** Names the boundary that caught the error in the report. */
  source: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
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
    reporter?.(error, {
      ...this.props.reportContext,
      componentStack: info.componentStack,
      source: this.props.source,
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
