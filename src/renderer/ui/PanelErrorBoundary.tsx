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
import { BaseErrorBoundary } from './BaseErrorBoundary'

interface Props {
  children?: React.ReactNode
  /** Panel type — surfaced in the fallback copy and the Sentry context. */
  panelType?: string
  /** Panel id — used both for the Sentry context and to auto-reset the
   *  boundary when the same slot is reused for a different panel. */
  panelId?: string
}

export function PanelErrorBoundary({ children, panelType, panelId }: Props): React.ReactElement {
  return (
    <BaseErrorBoundary
      resetKey={panelId}
      sentrySource="PanelErrorBoundary"
      sentryContext={{ panelType, panelId }}
      logError={(error, info) =>
        log.error(
          'Panel render error (type=%s id=%s): %s\n%s',
          panelType ?? 'unknown',
          panelId ?? 'unknown',
          error.message,
          info.componentStack,
        )
      }
      fallback={(error, reset) => {
        const label = panelType ? `This ${panelType} panel` : 'This panel'
        return (
          <div className="w-full h-full flex flex-col items-center justify-center bg-surface-4 text-secondary p-4 text-center select-none">
            <Warning size={30} className="mb-2 text-muted" weight="duotone" />
            <p className="text-sm font-medium mb-1">{label} hit an error</p>
            <p className="text-xs text-muted max-w-[28ch] truncate" title={error.message}>
              {error.message}
            </p>
            <button
              onClick={reset}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded bg-surface-6 hover:bg-hover text-primary transition-colors"
            >
              <ArrowClockwise size={13} />
              Reload panel
            </button>
          </div>
        )
      }}
    >
      {children}
    </BaseErrorBoundary>
  )
}
