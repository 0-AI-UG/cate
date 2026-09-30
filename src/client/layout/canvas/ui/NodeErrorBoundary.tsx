// Keeps a render error in one node's frame from tearing down the canvas. A
// node that throws usually has broken geometry and cannot be placed, so the
// fallback is nothing: the node disappears and the error is reported. Panel
// content errors are caught closer, by the host's panel boundary.

import React from 'react'
import { createLogger } from '@kernel/log/contract'
import { ErrorBoundary } from '@kernel/ui'

const log = createLogger('canvas')

export function NodeErrorBoundary({ children, nodeId }: { children?: React.ReactNode; nodeId?: string }): React.ReactElement {
  return (
    <ErrorBoundary
      resetKey={nodeId}
      source="NodeErrorBoundary"
      reportContext={{ nodeId }}
      logError={(error, info) => log.error(`canvas node render error (id=${nodeId ?? 'unknown'}): ${error.message}\n${info.componentStack}`)}
      fallback={() => null}
    >
      {children}
    </ErrorBoundary>
  )
}
