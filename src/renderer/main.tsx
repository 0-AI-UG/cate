import React from 'react'
import ReactDOM from 'react-dom/client'
import log from './lib/logger'
import App from './App'
import './styles/globals.css'

log.info('Renderer starting (window type=%s)', new URLSearchParams(window.location.search).get('type') ?? 'main')

window.addEventListener('error', (e) => {
  // Resource-load failures (img/script/link) fire a plain Event on the
  // failing element with no `.error` / `.message`. They aren't app
  // crashes and should not produce a crash report — otherwise every
  // transient asset hiccup triggers the "Cate crashed unexpectedly"
  // dialog on the next launch.
  if (!(e instanceof ErrorEvent)) return

  const err = e.error instanceof Error
    ? e.error
    : new Error(typeof e.message === 'string' && e.message ? e.message : 'Unknown error')

  // Defence against the classic `[object Event]` / `[object Object]`
  // stringification artefacts — those mean the handler received a
  // non-Error payload, not a real crash. Log but don't persist.
  if (err.message === '[object Event]' || err.message === '[object Object]' || !err.message) {
    log.warn('Ignoring non-informative error event:', e.error ?? e.message)
    return
  }

  log.error('Uncaught error:', err)
  window.electronAPI?.crashReportSave({ name: err.name, message: err.message, stack: err.stack })
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
    window.electronAPI?.crashReportSave({
      name: error.name,
      message: error.message,
      stack: [error.stack, '\nComponent stack:', errorInfo.componentStack].filter(Boolean).join('\n'),
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
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
