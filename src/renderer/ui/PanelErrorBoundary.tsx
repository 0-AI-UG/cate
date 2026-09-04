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
import { Button } from './Button'
import { PanelCenteredState } from './PanelCenteredState'

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
          <PanelCenteredState
            className="select-none"
            icon={<Warning size={30} weight="duotone" />}
            title={`${label} hit an error`}
            description={<span className="block max-w-[28ch] truncate" title={error.message}>
              {error.message}
            </span>}
            actions={<Button size="sm" onClick={reset}>
              <ArrowClockwise size={13} />
              Reload panel
            </Button>}
          />
        )
      }}
    >
      {children}
    </BaseErrorBoundary>
  )
}
