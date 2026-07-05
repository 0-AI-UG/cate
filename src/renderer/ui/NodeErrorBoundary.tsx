// =============================================================================
// NodeErrorBoundary
//
// Isolates a render error in a single canvas node's chrome (CanvasNode) so one
// broken node fails in place instead of tearing down the whole window via the
// top-level boundary in main.tsx. A node that throws can't be positioned (its
// geometry is exactly what's usually broken), so the fallback renders nothing —
// the node simply disappears — while the error is logged and reported to Sentry.
//
// Panel *content* errors are caught closer to the panel by PanelErrorBoundary;
// this covers the node frame around them.
// =============================================================================

import React from 'react'
import log from '../lib/logger'
import { BaseErrorBoundary } from './BaseErrorBoundary'

interface Props {
  children?: React.ReactNode
  /** Node id — surfaced in the Sentry context and used to auto-reset when the
   *  slot is reused for a different node. */
  nodeId?: string
}

export function NodeErrorBoundary({ children, nodeId }: Props): React.ReactElement {
  return (
    <BaseErrorBoundary
      resetKey={nodeId}
      sentrySource="NodeErrorBoundary"
      sentryContext={{ nodeId }}
      logError={(error, info) =>
        log.error(
          'Canvas node render error (id=%s): %s\n%s',
          nodeId ?? 'unknown',
          error.message,
          info.componentStack,
        )
      }
      // A node that throws can't be positioned (its geometry is usually what's
      // broken), so it simply disappears — no visible fallback.
      fallback={() => null}
    >
      {children}
    </BaseErrorBoundary>
  )
}
