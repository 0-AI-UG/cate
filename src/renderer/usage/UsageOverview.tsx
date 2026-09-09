import { LeftSidebarReopen, useLeftChromeInset } from '../shells/LeftSidebarReopen'
import { useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { useUIStore } from '../stores/uiStore'
import type { AgentHarnessPanelTarget } from '../../shared/t3Agent'
import { AGENT_CHAT_ONLY_CSS, isAllowedAgentHarnessNavigation } from '../lib/agentHarnessSurface'
import { USAGE_SURFACE_CSS, usageThemeScript } from './usageSurface'
import { getActiveTheme, subscribeTheme } from '../lib/themeManager'

interface UsageWebview extends HTMLElement {
  getURL(): string
  loadURL(url: string): Promise<void>
  insertCSS(css: string): Promise<string>
  executeJavaScript(script: string): Promise<unknown>
}

type State = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready'; target: AgentHarnessPanelTarget }

export default function UsageOverview() {
  const visible = useUIStore((s) => s.showUsage)
  return (
    <section
      aria-label="Usage overview"
      aria-hidden={!visible}
      style={visible ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
      className="absolute inset-0 z-40 flex flex-col bg-canvas-bg"
    >
      <LeftSidebarReopen />
      <UsagePage />
    </section>
  )
}

function UsagePage() {
  const leftChromeInset = useLeftChromeInset()
  const [panelId] = useState(() => `usage-${crypto.randomUUID()}`)
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [ready, setReady] = useState(false)
  const guestRef = useRef<UsageWebview | null>(null)

  useEffect(() => {
    let disposed = false
    setState({ phase: 'loading' })
    setReady(false)
    const getUsageUrl = window.electronAPI.agentHarnessGetUsageUrl
    if (!getUsageUrl) {
      setState({ phase: 'error', message: 'Restart Cate to load the updated Usage service.' })
      return
    }
    void getUsageUrl({ panelId }).then((result) => {
      if (disposed) return
      setState('error' in result ? { phase: 'error', message: result.error } : { phase: 'ready', target: result })
    }).catch((error: unknown) => {
      if (!disposed) setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    })
    return () => {
      disposed = true
      window.electronAPI.agentHarnessPanelClosed({ panelId })
    }
  }, [panelId, attempt])

  useEffect(() => {
    if (state.phase !== 'ready' || !guestRef.current) return
    const guest = guestRef.current
    const { target } = state
    let disposed = false
    const allowed = (url: string) => isAllowedAgentHarnessNavigation(url, target.url, target.environmentId, 'usage')
    const onNavigate = (event: Event) => {
      const navigation = event as Event & { url: string }
      if (!allowed(navigation.url)) navigation.preventDefault()
    }
    const onLocation = (event: Event) => {
      const navigation = event as Event & { url: string; isMainFrame?: boolean }
      if (navigation.isMainFrame !== false && !allowed(navigation.url)) void guest.loadURL(target.url)
    }
    const applyTheme = () => guest.executeJavaScript(usageThemeScript(getActiveTheme(), getComputedStyle(document.body).fontFamily))
    const onReady = () => {
      void Promise.all([guest.insertCSS(AGENT_CHAT_ONLY_CSS + USAGE_SURFACE_CSS), applyTheme()]).then(async () => {
        // dom-ready fires before the React route has replaced T3's startup
        // splash. Keep the guest hidden until the real Usage header exists so
        // the upstream logo never flashes through Cate's surface.
        await guest.executeJavaScript(`new Promise((resolve) => {
          const started = Date.now()
          const wait = () => {
            if (document.querySelector('[data-slot="sidebar-inset"] > header') || Date.now() - started > 10000) resolve(true)
            else setTimeout(wait, 16)
          }
          wait()
        })`)
        if (!disposed) setReady(true)
      }).catch((error: unknown) => {
        if (!disposed) setState({ phase: 'error', message: String(error) })
      })
    }
    const onFailed = (event: Event) => {
      const failure = event as Event & { errorCode: number; isMainFrame: boolean; errorDescription: string }
      if (failure.isMainFrame === false || failure.errorCode === -3) return
      setState({ phase: 'error', message: failure.errorDescription || 'Usage could not be loaded.' })
    }
    const preventNewWindow = (event: Event) => event.preventDefault()
    guest.addEventListener('dom-ready', onReady)
    guest.addEventListener('will-navigate', onNavigate)
    guest.addEventListener('did-navigate', onLocation)
    guest.addEventListener('did-navigate-in-page', onLocation)
    guest.addEventListener('did-fail-load', onFailed)
    guest.addEventListener('new-window', preventNewWindow)
    const unsubscribe = subscribeTheme(() => { void applyTheme().catch(() => undefined) })
    return () => {
      disposed = true
      unsubscribe()
      guest.removeEventListener('dom-ready', onReady)
      guest.removeEventListener('will-navigate', onNavigate)
      guest.removeEventListener('did-navigate', onLocation)
      guest.removeEventListener('did-navigate-in-page', onLocation)
      guest.removeEventListener('did-fail-load', onFailed)
      guest.removeEventListener('new-window', preventNewWindow)
    }
  }, [state])

  useEffect(() => {
    if (!ready || !guestRef.current) return
    void guestRef.current.executeJavaScript(
      `document.documentElement.style.setProperty('--cate-left-chrome-inset', '${leftChromeInset}px')`,
    ).catch(() => undefined)
  }, [ready, leftChromeInset])

  return (
    <div className="relative flex-1 min-h-0">
      {state.phase === 'error' ? (
        <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-primary">Usage unavailable</p>
          <p className="max-w-md text-xs text-muted">{state.message}</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="flex items-center gap-1.5 rounded bg-surface-2 px-3 py-1.5 text-xs text-secondary hover:text-primary">
            <RotateCw size={13} /> Retry
          </button>
        </div>
      ) : (
        <>
          {state.phase === 'ready' && (
            <webview ref={guestRef as any} src={state.target.url} partition={state.target.partition}
              data-usage-webview="" data-usage-ready={ready ? 'true' : 'false'}
              className={`h-full w-full${ready ? '' : ' invisible'}`} />
          )}
        </>
      )}
    </div>
  )
}
