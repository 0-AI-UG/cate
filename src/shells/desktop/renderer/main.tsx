// The desktop renderer entry: boots the client for this window, then renders.

import './splash'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '@kernel/ui'
import { createLogger } from '@kernel/log/contract'
import type { BrowserPageBridge } from '@services/browser/contract'
import { App } from './App'
import { bootDesktopClient, initRendererSentry } from './boot'
import './styles/globals.css'
import '@xterm/xterm/css/xterm.css'

declare global {
  interface Window {
    cateBrowserPage?: BrowserPageBridge
  }
}

const log = createLogger('renderer')
performance.mark('renderer-script-start')

const reportError = initRendererSentry()
window.addEventListener('error', (e) => {
  if (e instanceof ErrorEvent) log.error('Uncaught error: %s', e.error ?? e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  log.error('Unhandled promise rejection: %s', e.reason)
})

function Failed({ error }: { error: unknown }) {
  return (
    <div style={{ color: '#f87171', padding: 20, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
      <h2>Cate could not start this window</h2>
      <p>{error instanceof Error ? error.message : String(error)}</p>
      <button type="button" onClick={() => window.location.reload()} style={{ marginTop: 16, padding: '8px 16px' }}>Reload</button>
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
bootDesktopClient(window.cateDesktop, { pageBridge: window.cateBrowserPage, reportError }).then(
  (client) => {
    root.render(
      <StrictMode>
        <ErrorBoundary
          source="RootErrorBoundary"
          reportContext={{}}
          logError={(error, info) => log.error('React render error: %s %s', error.message, info.componentStack)}
          fallback={(error) => <Failed error={error} />}
        >
          <App client={client} />
        </ErrorBoundary>
      </StrictMode>,
    )
  },
  (error: unknown) => {
    log.error('boot failed: %s', error)
    reportError(error, { source: 'boot' })
    root.render(<Failed error={error} />)
  },
)
