import React from 'react'
import ReactDOM from 'react-dom/client'
import { IconContext } from '@phosphor-icons/react'
import log from './lib/logger'
import { mark } from './lib/perfMarks'
import { initRendererSentry, captureRendererException } from './lib/sentry'
import App from './App'
import { subscribeToOsNotificationClicks } from './lib/osNotifications'
import './styles/globals.css'
import '@xterm/xterm/css/xterm.css'

// Listen for OS notification clicks (focus the originating terminal).
subscribeToOsNotificationClicks()

// Phase 0 perf marker — first executable statement in the renderer bundle.
mark('renderer-script-start')

// Wire Sentry before the global error listeners below so renderer errors are
// captured both by Sentry and by the local crash-report dialog flow.
initRendererSentry()

log.info('Renderer starting (window type=%s)', new URLSearchParams(window.location.search).get('type') ?? 'main')

window.addEventListener('error', (e) => {
  if (!(e instanceof ErrorEvent)) return
  log.error('Uncaught error:', e.error ?? e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  log.error('Unhandled promise rejection:', e.reason)
})

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    log.error('React render error:', error.message, errorInfo.componentStack)
    // React swallows render errors before they reach window.onerror, so capture
    // explicitly here — otherwise top-level render crashes never reach Sentry.
    captureRendererException(error, {
      componentStack: errorInfo.componentStack,
      source: 'RootErrorBoundary',
    })
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ color: 'red', padding: 20, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          <h2>Render Error</h2>
          <p>{this.state.error.message}</p>
          <pre>{this.state.error.stack}</pre>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '8px 16px', cursor: 'pointer', background: '#333', color: '#fff', border: '1px solid #666', borderRadius: 4 }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Give every icon a touch more weight by default. Icons that set an
        explicit `weight` prop (bold/fill/duotone) override this. */}
    <IconContext.Provider value={{ weight: 'bold' }}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </IconContext.Provider>
  </React.StrictMode>
)
