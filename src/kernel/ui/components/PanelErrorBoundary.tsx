// Isolates a render error in a single panel so one broken panel fails in place
// instead of tearing down the whole window. Shows an inline fallback with a
// "Reload panel" action that resets the boundary and re-mounts the panel, and
// reports the error with panel context.

import React from 'react'
import { RotateCw as ArrowClockwise, TriangleAlert as Warning } from 'lucide-react'
import { createLogger } from '@kernel/log/contract'
import { ErrorBoundary } from './ErrorBoundary'
import { Button } from './Button'
import { PanelCenteredState } from './PanelCenteredState'
import { errorMessage } from './errorMessage'

const log = createLogger('ui')

interface Props {
  children?: React.ReactNode
  /** Panel type, shown in the fallback copy and the report context. */
  panelType?: string
  /** Panel id, for the report context and to reset the boundary when the slot
   *  is reused for a different panel. */
  panelId?: string
}

export function PanelErrorBoundary({ children, panelType, panelId }: Props): React.ReactElement {
  return (
    <ErrorBoundary
      resetKey={panelId}
      source="PanelErrorBoundary"
      reportContext={{ panelType, panelId }}
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
        const message = errorMessage(error, 'The panel could not be rendered.')
        return (
          <PanelCenteredState
            className="select-none"
            icon={<Warning size={30} />}
            title={`${label} hit an error`}
            description={<span className="block max-w-[28ch] truncate" title={message}>
              {message}
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
    </ErrorBoundary>
  )
}
